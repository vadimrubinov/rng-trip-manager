import { log } from "../lib/pino-logger";
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/async-handler";
import { tripsService } from "../services/trips.service";
import { tasksService } from "../services/tasks.service";
import { locationsService } from "../services/locations.service";
import { participantsService } from "../services/participants.service";
import { vendorInquiryService } from "../services/vendor-inquiry.service";

export const publicRouter = Router();

publicRouter.get("/:slug", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: "slug required" });

    const project = await tripsService.getBySlug(slug);
    if (!project) return res.status(404).json({ error: "Trip not found" });
    if (project.status === "cancelled") {
      return res.status(404).json({ error: "Trip not found" });
    }

    // Draft and frozen trips: only visible to owner
    if (project.status === "draft" || project.status === "frozen") {
      const userId = req.query.userId as string;
      if (!userId || userId !== project.user_id) {
        return res.status(404).json({ error: "Trip not found" });
      }
    }

    const [tasks, locations, participantRows] = await Promise.all([
      tasksService.listByProject(project.id),
      locationsService.listByProject(project.id),
      participantsService.listByProject(project.id),
    ]);

    // Vendor inquiries (limited fields for public route)
    const inquiries = await vendorInquiryService.listByProject(project.id);

    const publicTasks = tasks.map(t => ({
      id: t.id,
      type: t.type,
      title: t.title,
      description: t.description,
      deadline: t.deadline,
      status: t.status,
      sort_order: t.sort_order,
      vendor_name: t.vendor_name,
      vendor_record_id: t.vendor_record_id,
    }));

    const publicParticipants = participantRows
      .filter(p => p.status !== "declined")
      .map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        status: p.status,
      }));

    res.json({
      project: {
        id: project.id,
        slug: project.slug,
        title: project.title,
        description: project.description,
        cover_image_url: project.cover_image_url,
        status: project.status,
        payment_status: project.payment_status,
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
      participants: publicParticipants,
      vendor_inquiries: inquiries.map((i: any) => ({
        id: i.id,
        vendor_record_id: i.vendor_record_id,
        vendor_name: i.vendor_name,
        status: i.status,
        sent_at: i.sent_at,
        replied_at: i.replied_at,
        reply_classification: i.reply_classification,
        reply_summary: i.reply_summary,
      })),
    });
  } catch (e: any) {
    log.error({ err: e }, "[Public] Get trip");
    res.status(500).json({ error: "Internal server error" });
  }
}));

publicRouter.get("/:slug/invite/:token", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { slug, token } = req.params;

    const project = await tripsService.getBySlug(slug);
    if (!project) return res.status(404).json({ error: "Trip not found" });

    const participant = await participantsService.getByInviteToken(token);
    if (!participant) return res.status(404).json({ error: "Invalid invite" });
    if (participant.project_id !== project.id) {
      return res.status(404).json({ error: "Invalid invite" });
    }

    const tasks = await tasksService.listByProject(project.id);
    const locations = await locationsService.listByProject(project.id);

    res.json({
      project,
      participant,
      tasks,
      locations,
    });
  } catch (e: any) {
    log.error({ err: e }, "[Public] Get invite");
    res.status(500).json({ error: "Internal server error" });
  }
}));
