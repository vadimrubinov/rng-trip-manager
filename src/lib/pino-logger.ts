import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import { v4 as uuidv4 } from "uuid";
import { Request, Response, NextFunction } from "express";

interface RequestContext {
  correlationId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

export const log = pino({
  level,
  base: { service: "rng-trip-manager" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  mixin() {
    const ctx = requestContext.getStore();
    return ctx ? { correlationId: ctx.correlationId } : {};
  },
});

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.headers["x-correlation-id"] as string) || uuidv4();
  res.setHeader("x-correlation-id", correlationId);

  requestContext.run({ correlationId }, () => {
    log.info({ method: req.method, url: req.url }, "request.start");

    const startTime = Date.now();
    res.on("finish", () => {
      log.info(
        { method: req.method, url: req.url, statusCode: res.statusCode, duration: Date.now() - startTime },
        "request.end"
      );
    });

    next();
  });
}

export function getCorrelationId(): string {
  const ctx = requestContext.getStore();
  return ctx?.correlationId || "no-context";
}