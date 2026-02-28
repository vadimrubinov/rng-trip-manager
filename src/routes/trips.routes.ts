import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/async-handler";
import { tripsService, TripProjectRow } from "../services/trips.service";
import { tasksService } from "../services/tasks.service";
import { locationsService } from "../services/locations.service";
import { participantsService } from "../services/participants.service";
import { eventsService } from "../services/events.service";
import { plannerService } from "../services/planner.service";
import { emailService } from "../services/email/email.service";
import { nudgeService } from "../services/nudge/nudge.service";
import { query, queryOne, execute } from "../db/pool";
import { TripParticipantRow } from "../types";

export const tripsRouter = Router();

function getUserId(req: Request): string | null {
  const { clerkUserId } = req.body;
  return (clerkUserId && typeof clerkUserId === "string") ? clerkUserId : null;
}

function noAuth(res: Response) { return res.status(401).json({ error: "clerkUserId required" }); }

function formatDates(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return "Dates TBD";
  const opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" };
  const s = new Date(start);
  if (!end) return s.toLocaleDateString("en-US", opts);
  const e = new Date(end);
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.toLocaleDateString("en-US", { month: "long" })} ${s.getDate()}-${e.getDate()}, ${s.getFullYear()}`;
  }
  return `${s.toLocaleDateString("en-US", opts)} - ${e.toLocaleDateString("en-US", opts)}`;
}

tripsRouter.post("/generate-and-create", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return noAuth(res);

    const { scoutId, tripDetails, brief, status: requestedStatus, organizerEmail, organizerName } = req.body;

    // Accept brief as tripDetails alias
    const effectiveTripDetails = tripDetails || brief;

    if (!scoutId && !effectiveTripDetails) {
      return res.status(400).json({ error: "scoutId or tripDetails/brief required" });
    }

    // 1. Generate plan
    const plan = await plannerService.generatePlan({ scoutId, tripDetails: effectiveTripDetails });

    // 2. Create project
    const project = await tripsService.create(userId, {
      title: plan.project.title || "Untitled Trip",
      scoutId,
      description: plan.project.description,
      region: plan.project.region,
      country: plan.project.country,
      latitude: plan.project.latitude,
      longitude: plan.project.longitude,
      datesStart: plan.project.datesStart,
      datesEnd: plan.project.datesEnd,
      targetSpecies: plan.project.targetSpecies,
      tripType: plan.project.tripType,
      budgetMin: plan.project.budgetMin,
      budgetMax: plan.project.budgetMax,
      participantsCount: plan.project.participantsCount,
      experienceLevel: plan.project.experienceLevel,
      itinerary: plan.project.itinerary,
    });

    // 3. Set requested status (default is already 'draft' from DB)
    if (requestedStatus && requestedStatus !== "draft") {
      await tripsService.updateStatus(project.slug, requestedStatus);
    }

    // 4. Add organizer as participant
    await participantsService.create(project.id, { name: organizerName || "Organizer", email: organizerEmail || undefined, userId, role: "organizer" });

    // 5. Create tasks (batch)
    const tasks = [];
    for (const t of plan.tasks) {
      const task = await tasksService.create(project.id, t);
      tasks.push(task);
    }

    // 6. Create locations (batch)
    const locations = [];
    for (const loc of plan.locations) {
      const location = await locationsService.create(project.id, loc);
      locations.push(location);
    }

    // 7. Log event
    await eventsService.log(project.id, "trip_created", "agent", userId, {
      source: scoutId ? "scout" : "manual",
      tasks_count: tasks.length,
      locations_count: locations.length,
    });

    const tripUrl = `https://bitescout.com/trip/${project.slug}`;

    res.status(201).json({
      project: { ...project, status: requestedStatus || project.status },
      tasks,
      locations,
      tripUrl,
    });
  } catch (e: any) {
    console.error("[Trips] GenerateAndCreate:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

tripsRouter.post("/generate-plan", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return noAuth(res);

    const { scoutId, tripDetails, brief } = req.body;
    const effectiveTripDetails = tripDetails || brief;

    if (!scoutId && !effectiveTripDetails) {
      return res.status(400).json({ error: "scoutId or tripDetails/brief required" });
    }

    const plan = await plannerService.generatePlan({ scoutId, tripDetails: effectiveTripDetails });
    res.json(plan);
  } catch (e: any) {
    console.error("[Trips] GeneratePlan:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

tripsRouter.post("/update-status", asyncHandler(async (req: Request, res: Response) => {
  try {
    const isServerCall = !!req.headers["x-api-secret"];
    const userId = getUserId(req);
    if (!isServerCall && !userId) return noAuth(res);

    const { slug, status, paymentStatus, paymentId } = req.body;
    if (!slug || !status) {
      return res.status(400).json({ error: "slug and status required" });
    }

    const project = await tripsService.getBySlug(slug);
    if (!project) return res.status(404).json({ error: "Trip not found" });

    // Verify ownership for user calls; server calls are trusted (already auth'd by requireApiSecret)
    if (!isServerCall && project.user_id !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const updated = await tripsService.updateStatus(slug, status, {
      payment_status: paymentStatus,
      payment_id: paymentId,
    });

    // Send confirmation email when trip is activated
    if (status === "active") {
      (async () => {
        try {
          const organizer = await queryOne<TripParticipantRow>(
            "SELECT * FROM trip_participants WHERE project_id = $1 AND role = 'organizer' LIMIT 1",
            [project.id]
          );
          if (organizer?.email) {
            const variables: Record<string, string> = {
              trip_title: project.title || "Fishing Trip",
              organizer_name: organizer.name || "Organizer",
              destination: project.region || project.country || "TBD",
              dates: formatDates(project.dates_start, project.dates_end),
              trip_url: `https://bitescout.com/trip/${project.slug}`,
            };
            const result = await emailService.sendTemplate("trip_confirmation", organizer.email, variables);
            await eventsService.log(
              project.id,
              result.success ? "email_sent" : "email_failed",
              "system",
              null,
              { template_key: "trip_confirmation", to: organizer.email, messageId: result.messageId, error: result.error }
            );
          }
        } catch (err: any) {
          console.error("[Trips] Confirmation email error:", err?.message);
        }
      })();

      // Fire nudge event for trip activation
      try {
        await nudgeService.triggerEvent({
          projectId: project.id,
          eventType: "trip_activated",
          eventText: `Trip "${project.title}" has been activated and paid`,
        });
      } catch (e: any) {
        console.error("[Nudge] Event trigger:", e?.message);
      }
    }

    res.json(updated);
  } catch (e: any) {
    console.error("[Trips] UpdateStatus:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
}));

// Batch send invitations
tripsRouter.post("/invitations/send-all", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return noAuth(res);

    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: "projectId required" });

    // Verify ownership
    const project = await queryOne<TripProjectRow>(
      "SELECT * FROM trip_projects WHERE id = $1",
      [projectId]
    );
    if (!project) return res.status(404).json({ error: "Trip not found" });
    if (project.user_id !== userId) return res.status(403).json({ error: "Forbidden" });

    // Find unsent invitations
    const participants = await query<TripParticipantRow>(
      `SELECT * FROM trip_participants 
       WHERE project_id = $1 AND status = 'invited' AND email IS NOT NULL AND invite_sent_at IS NULL AND role != 'organizer'`,
      [projectId]
    );

    const organizer = await queryOne<TripParticipantRow>(
      "SELECT * FROM trip_participants WHERE project_id = $1 AND role = 'organizer' LIMIT 1",
      [projectId]
    );

    let sent = 0;
    let failed = 0;
    const errors: Array<{ participantId: string; error: string }> = [];

    for (const p of participants) {
      const variables: Record<string, string> = {
        trip_title: project.title || "Fishing Trip",
        organizer_name: organizer?.name || "The organizer",
        destination: project.region || project.country || "TBD",
        dates: formatDates(project.dates_start, project.dates_end),
        invite_link: `https://bitescout.com/trip/${project.slug}?token=${p.invite_token || ""}`,
        trip_url: `https://bitescout.com/trip/${project.slug}`,
      };

      const result = await emailService.sendTemplate("trip_invitation", p.email!, variables);

      await eventsService.log(
        projectId,
        result.success ? "email_sent" : "email_failed",
        "system",
        null,
        { template_key: "trip_invitation", to: p.email, messageId: result.messageId, error: result.error },
        "participant",
        p.id
      );

      if (result.success) {
        sent++;
        await execute("UPDATE trip_participants SET invite_sent_at = NOW() WHERE id = $1", [p.id]);

        // CC organizer
        if (organizer?.email) {
          try {
            const settings = await emailService.loadSettings();
            if (settings.EMAIL_CC_ORGANIZER === "true") {
              await emailService.sendTemplate("trip_invitation", organizer.email, variables);
            }
          } catch {}
        }
      } else {
        failed++;
        errors.push({ participantId: p.id, error: result.error || "Unknown" });
      }
    }

    res.json({ sent, failed, errors });

    // Fire nudge event for invitations sent (fire-and-forget)
    if (sent > 0) {
      try {
        await nudgeService.triggerEvent({
          projectId,
          eventType: "invitations_sent",
          eventText: `Trip invitations sent to ${sent} participants`,
        });
      } catch (e: any) {
        console.error("[Nudge] Event trigger:", e?.message);
      }
    }
  } catch (e: any) {
    console.error("[Trips] SendAll:", e?.message);
    res.status(500).json({ error: e?.message || "Internal server error" });
  }
}));

tripsRouter.get("/list", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return noAuth(res);

    const projects = await tripsService.listByUser(userId);
    res.json(projects);
  } catch (e: any) {
    console.error("[Trips] List:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
}));

tripsRouter.get("/detail/:id", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return noAuth(res);

    const { id } = req.params;
    const project = await tripsService.getById(id);

    if (!project) return res.status(404).json({ error: "Trip not found" });
    if (project.user_id !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const [tasks, locations, participants] = await Promise.all([
      tasksService.listByProject(id),
      locationsService.listByProject(id),
      participantsService.listByProject(id),
    ]);

    res.json({ project, tasks, locations, participants });
  } catch (e: any) {
    console.error("[Trips] Detail:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
}));

tripsRouter.post("/update", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return noAuth(res);

    const { id, title, description, region, country, datesStart, datesEnd } = req.body;
    if (!id) return res.status(400).json({ error: "id required" });

    const project = await tripsService.getById(id);
    if (!project) return res.status(404).json({ error: "Trip not found" });
    if (project.user_id !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const sets: string[] = ["updated_at = NOW()"];
    const params: any[] = [];
    let i = 1;

    if (title !== undefined) {
      params.push(title);
      sets.push(`title = $${i++}`);
    }
    if (description !== undefined) {
      params.push(description);
      sets.push(`description = $${i++}`);
    }
    if (region !== undefined) {
      params.push(region);
      sets.push(`region = $${i++}`);
    }
    if (country !== undefined) {
      params.push(country);
      sets.push(`country = $${i++}`);
    }
    if (datesStart !== undefined) {
      params.push(datesStart);
      sets.push(`dates_start = $${i++}`);
    }
    if (datesEnd !== undefined) {
      params.push(datesEnd);
      sets.push(`dates_end = $${i++}`);
    }

    params.push(id);
    const result = await tripsService.getById(id);

    res.json(result);
  } catch (e: any) {
    console.error("[Trips] Update:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
}));

tripsRouter.post("/delete", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return noAuth(res);

    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "id required" });

    const project = await tripsService.getById(id);
    if (!project) return res.status(404).json({ error: "Trip not found" });
    if (project.user_id !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await tripsService.delete(id);
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Trips] Delete:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
}));

tripsRouter.post("/unfreeze-all", asyncHandler(async (req: Request, res: Response) => {
  try {
    const { clerkUserId } = req.body;
    if (!clerkUserId) return res.status(400).json({ error: "clerkUserId required" });

    const count = await execute(
      `UPDATE trip_projects SET status = 'active' WHERE user_id = $1 AND status = 'frozen'`,
      [clerkUserId]
    );

    console.log(`[Trips] Unfreeze-all: user=${clerkUserId}, unfrozen=${count}`);
    res.json({ ok: true, unfrozen: count });
  } catch (e: any) {
    console.error("[Trips] Unfreeze-all:", e?.message);
    res.status(500).json({ error: "Internal server error" });
  }
}));
