import { Server } from "http";
import { log } from "./pino-logger";

interface ShutdownOptions {
  server: Server;
  timeoutMs?: number;
  onShutdown?: () => Promise<void>;
}

export function registerGracefulShutdown(options: ShutdownOptions): void {
  const { server, timeoutMs = 25000, onShutdown } = options;
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info({ signal }, "shutdown.start");

    const forceTimer = setTimeout(() => {
      log.error("shutdown.timeout — forcing exit");
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log.info("shutdown.server_closed");

      if (onShutdown) {
        await onShutdown();
        log.info("shutdown.cleanup_done");
      }

      log.flush();
      log.info("shutdown.complete");
      process.exit(0);
    } catch (err) {
      log.error({ err }, "shutdown.error");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}