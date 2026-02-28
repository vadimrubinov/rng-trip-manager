import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/async-handler";
import { nudgeService } from "../services/nudge/nudge.service";
import { nudgeNotifications } from "../services/nudge/nudge.notifications";

export const nudgeRouter = Router();

// Manual trigger: POST /api/nudge/run
nudgeRouter.post("/run", asyncHandler(async (_req: Request, res: Response) => {
  try {
    console.log("[NudgeAPI] Manual run triggered");
    const result = await nudgeService.runCycle();
    res.json(result);
  } catch (e: any) {
    console.error("[NudgeAPI] Run error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

// Trigger event: POST /api/nudge/trigger-event
nudgeRouter.post("/trigger-event", asyncHandler(async (req: Request, res: Response) => {
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
}));

// Get notifications for a project: GET /api/nudge/notifications/:projectId
nudgeRouter.get("/notifications/:projectId", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const notifications = await nudgeNotifications.listByProject(projectId);
    res.json(notifications);
  } catch (e: any) {
    console.error("[NudgeAPI] ListNotifications error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

// Get nudge settings: GET /api/nudge/settings
nudgeRouter.get("/settings", asyncHandler(async (_req: Request, res: Response) => {
  try {
    const settings = await nudgeService.loadSettings();
    res.json(settings);
  } catch (e: any) {
    console.error("[NudgeAPI] Settings error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

// Get all notifications for a user: GET /api/nudge/user-notifications?clerkUserId=...
nudgeRouter.get("/user-notifications", asyncHandler(async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.query.clerkUserId as string;
    if (!clerkUserId) {
      return res.status(400).json({ error: "clerkUserId required" });
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const notifications = await nudgeNotifications.listByUser(clerkUserId, limit);
    res.json({ notifications });
  } catch (e: any) {
    console.error("[NudgeAPI] UserNotifications error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

// Get unread count for a user: GET /api/nudge/unread-count?clerkUserId=...
nudgeRouter.get("/unread-count", asyncHandler(async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.query.clerkUserId as string;
    if (!clerkUserId) {
      return res.status(400).json({ error: "clerkUserId required" });
    }
    const count = await nudgeNotifications.countUnread(clerkUserId);
    res.json({ count });
  } catch (e: any) {
    console.error("[NudgeAPI] UnreadCount error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

// Mark single notification as read: POST /api/nudge/notifications/read
nudgeRouter.post("/notifications/read", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { notificationId } = req.body;
    if (!notificationId) {
      return res.status(400).json({ error: "notificationId required" });
    }
    await nudgeNotifications.markAsRead(notificationId);
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[NudgeAPI] MarkRead error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

// Mark all notifications as read for user: POST /api/nudge/notifications/read-all
nudgeRouter.post("/notifications/read-all", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { clerkUserId } = req.body;
    if (!clerkUserId) {
      return res.status(400).json({ error: "clerkUserId required" });
    }
    const count = await nudgeNotifications.markAllAsRead(clerkUserId);
    res.json({ ok: true, marked: count });
  } catch (e: any) {
    console.error("[NudgeAPI] MarkAllRead error:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));
