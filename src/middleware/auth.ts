import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { ENV } from "../config/env";

export function requireApiSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-api-secret"];
  if (!secret || typeof secret !== "string") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const match = crypto.timingSafeEqual(
      Buffer.from(secret),
      Buffer.from(ENV.API_SECRET)
    );
    if (!match) return res.status(401).json({ error: "Unauthorized" });
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
