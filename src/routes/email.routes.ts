import { log } from "../lib/pino-logger";
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/async-handler";
import { emailService } from "../services/email/email.service";

export const emailRouter = Router();

/**
 * POST /api/email/test
 * Send a test email using a template.
 */
emailRouter.post("/test", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { template_key, to, variables } = req.body;

    if (!template_key || !to) {
      return res.status(400).json({ error: "template_key and to required" });
    }

    // Render for preview
    const rendered = await emailService.renderTemplate(template_key, variables || {});
    if ("error" in rendered) {
      return res.status(400).json({ success: false, error: rendered.error });
    }

    // Send
    const result = await emailService.sendTemplate(template_key, to, variables || {});

    res.json({
      success: result.success,
      messageId: result.messageId,
      error: result.error,
      html_preview: rendered.html,
    });
  } catch (e: any) {
    log.error({ err: e }, "[Email] Test endpoint");
    res.status(500).json({ success: false, error: e?.message || "Internal error" });
  }
}));

/**
 * POST /api/email/preview
 * Render a template to HTML without sending.
 */
emailRouter.post("/preview", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { template_key, variables } = req.body;

    if (!template_key) {
      return res.status(400).json({ error: "template_key required" });
    }

    const result = await emailService.renderTemplate(template_key, variables || {});
    if ("error" in result) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ html: result.html });
  } catch (e: any) {
    log.error({ err: e }, "[Email] Preview endpoint");
    res.status(500).json({ error: e?.message || "Internal error" });
  }
}));
