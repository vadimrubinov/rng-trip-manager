import { Router, Request, Response } from "express";
import { tripsService } from "../services/trips.service";
import { tasksService } from "../services/tasks.service";
import { locationsService } from "../services/locations.service";
import { participantsService } from "../services/participants.service";

export const publicRouter = Router();

// Must be BEFORE /:slug to avoid route conflict
publicRouter.get("/invite/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: "token required" });

    const participant = await participantsService.getByInviteToken(token);
    if (!participant) return res.status(404).json({ error: "Invite not found" });

    const project = await tripsService.getById(participant.project_id);
    if (!project || project.status === "cancelled") {
      return res.status(404).json({ error: "Trip no longer available" });
    }

    res.json({
      participant: {
        name: participant.name,
        status: participant.status,
        role: participant.role,
      },
      project: {
        slug: project.slug,
        title: project.title,
        region: project.region,
        dates_start: project.dates_start,
        dates_end: project.dates_end,
      },
    });
  } catch (e: any) {
    console.error("[Public] Invite lookup:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

publicRouter.get("/:slug", async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: "slug required" });

    const project = await tripsService.getBySlug(slug);
    if (!project) return res.status(404).json({ error: "Trip not found" });
    if (project.status === "cancelled") return res.status(404).json({ error: "Trip not found" });

    const [tasks, locations] = await Promise.all([
      tasksService.listByProject(project.id),
      locationsService.listByProject(project.id),
    ]);

    const publicTasks = tasks.map(t => ({
      id: t.id,
      type: t.type,
      title: t.title,
      description: t.description,
      deadline: t.deadline,
      status: t.status,
      sort_order: t.sort_order,
      vendor_name: t.vendor_name,
    }));

    res.json({
      project: {
        id: project.id,
        slug: project.slug,
        title: project.title,
        description: project.description,
        cover_image_url: project.cover_image_url,
        status: project.status,
        region: project.region,
        country: project.country,
        latitude: project.latitude,
        longitude: project.longitude,
        dates_start: project.dates_start,
        dates_end: project.dates_end,
        target_species: project.target_species,
        trip_type: project.trip_type,
        budget_min: project.budget_min,
        budget_max: project.budget_max,
        participants_count: project.participants_count,
        experience_level: project.experience_level,
        itinerary: project.itinerary,
        created_at: project.created_at,
      },
      tasks: publicTasks,
      locations,
    });
  } catch (e: any) {
    console.error("[Public] Get trip:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
});
