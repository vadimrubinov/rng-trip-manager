import { Request, Response, NextFunction } from "express";
import { log, getCorrelationId } from "./pino-logger";

export function errorMiddleware(err: any, req: Request, res: Response, _next: NextFunction): void {
  const correlationId = getCorrelationId();
  const status = err.statusCode || err.status || 500;
  const message = status < 500 ? err.message : "Internal server error";

  log.error(
    {
      err: { message: err.message, stack: err.stack, code: err.code },
      method: req.method,
      url: req.url,
      statusCode: status,
      correlationId,
    },
    "request.error"
  );

  if (!res.headersSent) {
    res.status(status).json({ error: true, message, correlationId });
  }
}

export function registerProcessHandlers(shutdownFn?: () => Promise<void>): void {
  process.on("unhandledRejection", (reason: any) => {
    log.error({ err: reason }, "process.unhandledRejection");
  });

  process.on("uncaughtException", (err: Error) => {
    log.fatal({ err }, "process.uncaughtException");
    if (shutdownFn) {
      shutdownFn().finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  });
}