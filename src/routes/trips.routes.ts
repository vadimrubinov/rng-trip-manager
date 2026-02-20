import { Router, Request, Response } from "express";
import { tripsService } from "../services/trips.service";
import { tasksService } from "../services/tasks.service";
import { eventsService } from "../services/events.service";
import { participantsService } from "../services/participants.service";
import { locationsService } from "../services/locations.service";
import { plannerService } from "../services/planner.service";

export const tripsRouter = Router();

function getUserId(req: Request): string | null {
  const { clerkUserId } = req.body;
  return (clerkUserId && typeof clerkUserId === "string") ? clerkUserId : null;
}

function noAuth(res: Response) { return res.status(401).json({ error: "clerkUserId required" }); }

// === PROJECTS ===

tripsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    if (!req.body.title) return res.status(400).json({ error: "title required" });

    const project = await tripsService.create(userId, req.body);
    await participantsService.create(project.id, { name: "Organizer", userId, role: "organizer" });
    await eventsService.log(project.id, "trip_created", "user", userId, { title: project.title });

    res.status(201).json(project);
  } catch (e: any) {
    console.error("[Trips] Create:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/list", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const trips = await tripsService.list(userId, req.body.status, req.body.limit, req.body.offset);
    res.json({ trips });
  } catch (e: any) {
    console.error("[Trips] List:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/detail", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const [project, tasks, participants, locations, recentEvents] = await Promise.all([
      tripsService.getById(projectId),
      tasksService.listByProject(projectId),
      participantsService.listByProject(projectId),
      locationsService.listByProject(projectId),
      eventsService.listByProject(projectId, 20),
    ]);
    if (!project) return res.status(404).json({ error: "Not found" });

    res.json({ project, tasks, participants, locations, recentEvents });
  } catch (e: any) {
    console.error("[Trips] Detail:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/update", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, clerkUserId, ...data } = req.body;
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const updated = await tripsService.update(projectId, data);
    await eventsService.log(projectId, "trip_updated", "user", userId, { fields: Object.keys(data) });
    res.json(updated);
  } catch (e: any) {
    console.error("[Trips] Update:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/delete", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    await tripsService.delete(projectId);
    await eventsService.log(projectId, "trip_cancelled", "user", userId);
    res.json({ success: true });
  } catch (e: any) {
    console.error("[Trips] Delete:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === TASKS ===

tripsRouter.post("/tasks/create", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, type, title } = req.body;
    if (!projectId || !type || !title) return res.status(400).json({ error: "projectId, type, title required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const task = await tasksService.create(projectId, req.body);
    await eventsService.log(projectId, "task_created", "user", userId, { task_id: task.id, title: task.title }, "task", task.id);
    res.status(201).json(task);
  } catch (e: any) {
    console.error("[Tasks] Create:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/tasks/update", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, taskId, clerkUserId, ...data } = req.body;
    if (!projectId || !taskId) return res.status(400).json({ error: "projectId, taskId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const task = await tasksService.update(taskId, data);
    await eventsService.log(projectId, "task_updated", "user", userId, { task_id: taskId }, "task", taskId);
    res.json(task);
  } catch (e: any) {
    console.error("[Tasks] Update:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/tasks/complete", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, taskId } = req.body;
    if (!projectId || !taskId) return res.status(400).json({ error: "projectId, taskId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const task = await tasksService.complete(taskId);
    await eventsService.log(projectId, "task_completed", "user", userId, { task_id: taskId, title: task?.title }, "task", taskId);
    res.json(task);
  } catch (e: any) {
    console.error("[Tasks] Complete:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/tasks/delete", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, taskId } = req.body;
    if (!projectId || !taskId) return res.status(400).json({ error: "projectId, taskId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    await tasksService.delete(taskId);
    await eventsService.log(projectId, "task_deleted", "user", userId, { task_id: taskId }, "task", taskId);
    res.json({ success: true });
  } catch (e: any) {
    console.error("[Tasks] Delete:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === EVENTS ===

tripsRouter.post("/events", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const events = await eventsService.listByProject(projectId, req.body.limit || 50, req.body.offset || 0);
    res.json({ events });
  } catch (e: any) {
    console.error("[Events] List:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === PARTICIPANTS ===

tripsRouter.post("/participants/create", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, name } = req.body;
    if (!projectId || !name) return res.status(400).json({ error: "projectId, name required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const p = await participantsService.create(projectId, req.body);
    await eventsService.log(projectId, "participant_invited", "user", userId, { name }, "participant", p.id);
    res.status(201).json(p);
  } catch (e: any) {
    console.error("[Participants] Create:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/participants/update", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, participantId, clerkUserId, ...data } = req.body;
    if (!projectId || !participantId) return res.status(400).json({ error: "projectId, participantId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const p = await participantsService.update(participantId, data);
    res.json(p);
  } catch (e: any) {
    console.error("[Participants] Update:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/participants/delete", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, participantId } = req.body;
    if (!projectId || !participantId) return res.status(400).json({ error: "projectId, participantId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    await participantsService.delete(participantId);
    res.json({ success: true });
  } catch (e: any) {
    console.error("[Participants] Delete:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === LOCATIONS ===

tripsRouter.post("/locations/create", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, name, latitude, longitude } = req.body;
    if (!projectId || !name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: "projectId, name, latitude, longitude required" });
    }
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const loc = await locationsService.create(projectId, req.body);
    await eventsService.log(projectId, "location_added", "user", userId, { name: loc.name }, "location", loc.id);
    res.status(201).json(loc);
  } catch (e: any) {
    console.error("[Locations] Create:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/locations/update", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, locationId, clerkUserId, ...data } = req.body;
    if (!projectId || !locationId) return res.status(400).json({ error: "projectId, locationId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    const loc = await locationsService.update(locationId, data);
    res.json(loc);
  } catch (e: any) {
    console.error("[Locations] Update:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

tripsRouter.post("/locations/delete", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { projectId, locationId } = req.body;
    if (!projectId || !locationId) return res.status(400).json({ error: "projectId, locationId required" });
    if (!(await tripsService.verifyOwnership(projectId, userId))) return res.status(403).json({ error: "Access denied" });

    await locationsService.delete(locationId);
    res.json({ success: true });
  } catch (e: any) {
    console.error("[Locations] Delete:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === GENERATE PLAN ===

tripsRouter.post("/generate-plan", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req); if (!userId) return noAuth(res);
    const { scoutId, tripDetails } = req.body;
    if (!scoutId && !tripDetails) return res.status(400).json({ error: "scoutId or tripDetails required" });

    const plan = await plannerService.generatePlan({ scoutId, tripDetails });
    res.json(plan);
  } catch (e: any) {
    console.error("[Planner] Generate:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
});
