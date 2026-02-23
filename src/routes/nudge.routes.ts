import { Router, Request, Response } from "express";
import { nudgeService } from "../services/nudge/nudge.service";
import { nudgeNotifications } from "../services/nudge/nudge.notifications";

export const nudgeRouter = Router();

// Manual trigger: POST /api/nudge/run
nudgeRouter.post("/run", async (_req: Request, res: Response) => {
  try {
    console.log("[NudgeAPI] Manual run triggered");
    const result = await nudgeService.runCycle();
    res.json(result);
  } catch (e: any) {
    console.error("[NudgeAPI] Run error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
});

// Trigger event: POST /api/nudge/trigger-event
nudgeRouter.post("/trigger-event", async (req: Request, res: Response) => {
  try {
    const { projectId, eventType, eventText } = req.body;
    if (!projectId || !eventType) {
      return res.status(400).json({ error: "projectId and eventType required" });
    }
    await nudgeService.triggerEvent({
      projectId,
      eventType,
      eventText: eventText || eventType,
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[NudgeAPI] TriggerEvent error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
});

// Get notifications for a project: GET /api/nudge/notifications/:projectId
nudgeRouter.get("/notifications/:projectId", async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const notifications = await nudgeNotifications.listByProject(projectId);
    res.json(notifications);
  } catch (e: any) {
    console.error("[NudgeAPI] ListNotifications error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
});

// Get nudge settings: GET /api/nudge/settings
nudgeRouter.get("/settings", async (_req: Request, res: Response) => {
  try {
    const settings = await nudgeService.loadSettings();
    res.json(settings);
  } catch (e: any) {
    console.error("[NudgeAPI] Settings error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
});
