import { query, queryOne, execute } from "../../db/pool";
import { emailService } from "../email/email.service";
import { eventsService } from "../events.service";
import { nudgeNotifications } from "./nudge.notifications";
import { generateNudgeMessage } from "./nudge.ai";
import { NudgeCandidate, NudgeSettings, DEFAULT_NUDGE_SETTINGS } from "./nudge.types";
import { TripProjectRow, TripTaskRow, TripParticipantRow } from "../../types";

// Settings cache
let settingsCache: { data: NudgeSettings; ts: number } | null = null;
const SETTINGS_TTL = 5 * 60 * 1000;

export async function loadNudgeSettings(): Promise<NudgeSettings> {
  if (settingsCache && Date.now() - settingsCache.ts < SETTINGS_TTL) {
    return settingsCache.data;
  }
  try {
    const { getNudgeSettings } = await import("../../lib/airtable");
    const raw = await getNudgeSettings();
    const settings: NudgeSettings = {
      NUDGE_ENABLED: raw.NUDGE_ENABLED !== "false",
      NUDGE_DEADLINE_DAYS: parseNumberArray(raw.NUDGE_DEADLINE_DAYS, DEFAULT_NUDGE_SETTINGS.NUDGE_DEADLINE_DAYS),
      NUDGE_COUNTDOWN_DAYS: parseNumberArray(raw.NUDGE_COUNTDOWN_DAYS, DEFAULT_NUDGE_SETTINGS.NUDGE_COUNTDOWN_DAYS),
      NUDGE_OVERDUE_DAYS: parseNumberArray(raw.NUDGE_OVERDUE_DAYS, DEFAULT_NUDGE_SETTINGS.NUDGE_OVERDUE_DAYS),
      NUDGE_QUIET_HOURS_START: parseInt(raw.NUDGE_QUIET_HOURS_START || "", 10) || DEFAULT_NUDGE_SETTINGS.NUDGE_QUIET_HOURS_START,
      NUDGE_QUIET_HOURS_END: parseInt(raw.NUDGE_QUIET_HOURS_END || "", 10) || DEFAULT_NUDGE_SETTINGS.NUDGE_QUIET_HOURS_END,
      NUDGE_MAX_PER_DAY_PER_USER: parseInt(raw.NUDGE_MAX_PER_DAY_PER_USER || "", 10) || DEFAULT_NUDGE_SETTINGS.NUDGE_MAX_PER_DAY_PER_USER,
    };
    settingsCache = { data: settings, ts: Date.now() };
    return settings;
  } catch (err: any) {
    console.error("[Nudge] Failed to load settings:", err?.message);
    return DEFAULT_NUDGE_SETTINGS;
  }
}

function parseNumberArray(val: string | undefined, fallback: number[]): number[] {
  if (!val) return fallback;
  const nums = val.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return nums.length > 0 ? nums : fallback;
}

function daysBetween(from: Date, to: Date): number {
  const msPerDay = 86400000;
  return Math.round((to.getTime() - from.getTime()) / msPerDay);
}

function isQuietHours(settings: NudgeSettings): boolean {
  const hour = new Date().getUTCHours();
  const start = settings.NUDGE_QUIET_HOURS_START;
  const end = settings.NUDGE_QUIET_HOURS_END;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Wraps midnight: e.g. 22..8
  return hour >= start || hour < end;
}

function formatDates(start: string | null, end: string | null): string {
  if (!start) return "Dates TBD";
  const opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" };
  const s = new Date(start);
  if (!end) return s.toLocaleDateString("en-US", opts);
  const e = new Date(end);
  return `${s.toLocaleDateString("en-US", opts)} – ${e.toLocaleDateString("en-US", opts)}`;
}

export const nudgeService = {
  loadSettings: loadNudgeSettings,

  async runCycle(): Promise<{ processed: number; notifications: string[]; errors: string[] }> {
    const settings = await loadNudgeSettings();
    const results = { processed: 0, notifications: [] as string[], errors: [] as string[] };

    if (!settings.NUDGE_ENABLED) {
      console.log("[NudgeCron] Disabled via settings");
      return results;
    }

    if (isQuietHours(settings)) {
      console.log("[NudgeCron] Quiet hours — skipping");
      return results;
    }

    // Find active projects with dates
    const projects = await query<TripProjectRow>(
      `SELECT * FROM trip_projects WHERE status = 'active' AND dates_start IS NOT NULL`
    );

    if (projects.length === 0) {
      console.log("[NudgeCron] No active projects");
      return results;
    }

    const now = new Date();
    const candidates: NudgeCandidate[] = [];

    for (const project of projects) {
      const tasks = await query<TripTaskRow>(
        `SELECT * FROM trip_tasks WHERE project_id = $1 AND status NOT IN ('completed', 'skipped')`,
        [project.id]
      );
      const participants = await query<TripParticipantRow>(
        `SELECT * FROM trip_participants WHERE project_id = $1 AND status = 'confirmed'`,
        [project.id]
      );

      if (participants.length === 0) continue;

      const organizer = participants.find(p => p.role === "organizer");
      const tripDatesStr = formatDates(project.dates_start, project.dates_end);
      const speciesStr = project.target_species?.join(", ") || "";

      // COUNTDOWN triggers
      const daysUntilTrip = daysBetween(now, new Date(project.dates_start!));
      if (daysUntilTrip >= 0 && settings.NUDGE_COUNTDOWN_DAYS.includes(daysUntilTrip)) {
        candidates.push({
          projectId: project.id,
          projectTitle: project.title,
          projectSlug: project.slug,
          triggerType: "countdown",
          automationMode: "remind",
          recipientIds: participants.map(p => p.id),
          daysUntil: daysUntilTrip,
          contextData: {
            trip_title: project.title,
            trip_region: project.region || "",
            trip_dates: tripDatesStr,
            target_species: speciesStr,
            days: String(daysUntilTrip),
            trip_slug: project.slug,
          },
        });
      }

      // DEADLINE + OVERDUE triggers per task
      for (const task of tasks) {
        if (!task.deadline) continue;

        const daysUntil = daysBetween(now, new Date(task.deadline));

        // DEADLINE: future
        if (daysUntil >= 0 && settings.NUDGE_DEADLINE_DAYS.includes(daysUntil)) {
          const recipientIds = task.assigned_to
            ? [task.assigned_to]
            : organizer ? [organizer.id] : [];

          if (recipientIds.length > 0) {
            candidates.push({
              projectId: project.id,
              projectTitle: project.title,
              projectSlug: project.slug,
              taskId: task.id,
              taskTitle: task.title,
              triggerType: "deadline",
              automationMode: task.automation_mode || "remind",
              recipientIds,
              daysUntil,
              contextData: {
                trip_title: project.title,
                trip_region: project.region || "",
                trip_dates: tripDatesStr,
                target_species: speciesStr,
                task_title: task.title,
                task_type: task.type,
                days: String(daysUntil),
                trip_slug: project.slug,
              },
            });
          }
        }

        // OVERDUE: past deadline
        const daysOverdue = -daysUntil;
        if (daysOverdue > 0 && settings.NUDGE_OVERDUE_DAYS.includes(daysOverdue)) {
          const recipientIds: string[] = [];
          if (task.assigned_to) recipientIds.push(task.assigned_to);
          if (organizer && organizer.id !== task.assigned_to) recipientIds.push(organizer.id);
          if (recipientIds.length === 0 && organizer) recipientIds.push(organizer.id);

          if (recipientIds.length > 0) {
            candidates.push({
              projectId: project.id,
              projectTitle: project.title,
              projectSlug: project.slug,
              taskId: task.id,
              taskTitle: task.title,
              triggerType: "overdue",
              automationMode: task.automation_mode || "remind",
              recipientIds,
              daysUntil: -daysOverdue,
              contextData: {
                trip_title: project.title,
                trip_region: project.region || "",
                trip_dates: tripDatesStr,
                target_species: speciesStr,
                task_title: task.title,
                task_type: task.type,
                days: String(daysOverdue),
                trip_slug: project.slug,
              },
            });
          }
        }
      }
    }

    console.log(`[NudgeCron] ${candidates.length} candidates from ${projects.length} projects`);

    // Process candidates
    for (const candidate of candidates) {
      for (const participantId of candidate.recipientIds) {
        try {
          // Deduplication
          const isDup = await nudgeNotifications.isDuplicate(
            candidate.projectId,
            candidate.taskId,
            candidate.triggerType,
            participantId
          );
          if (isDup) continue;

          // Daily limit
          const todayCount = await nudgeNotifications.countTodayForParticipant(participantId);
          if (todayCount >= settings.NUDGE_MAX_PER_DAY_PER_USER) {
            // Create skipped record
            const notif = await nudgeNotifications.create({
              projectId: candidate.projectId,
              taskId: candidate.taskId,
              participantId,
              triggerType: candidate.triggerType,
              channel: "in_app",
              metadata: candidate.contextData,
            });
            await nudgeNotifications.markSkipped(notif.id, "daily_limit_reached");
            continue;
          }

          // Get participant info
          const participant = await queryOne<TripParticipantRow>(
            `SELECT * FROM trip_participants WHERE id = $1`,
            [participantId]
          );
          if (!participant) continue;

          // Generate AI message
          const message = await generateNudgeMessage({
            triggerType: candidate.triggerType,
            automationMode: candidate.automationMode,
            tripTitle: candidate.projectTitle,
            tripRegion: candidate.contextData.trip_region,
            tripDates: candidate.contextData.trip_dates,
            targetSpecies: candidate.contextData.target_species,
            taskTitle: candidate.taskTitle,
            taskType: candidate.contextData.task_type,
            days: candidate.daysUntil !== undefined ? Math.abs(candidate.daysUntil) : undefined,
            participantName: participant.name,
          });

          // Create in_app notification
          await nudgeNotifications.create({
            projectId: candidate.projectId,
            taskId: candidate.taskId,
            participantId,
            triggerType: candidate.triggerType,
            channel: "in_app",
            messageSubject: message.subject,
            messageText: message.body,
            metadata: candidate.contextData,
          });

          // Send email if participant has email
          if (participant.email) {
            const templateKey = `nudge_${candidate.triggerType}`;
            const emailVars: Record<string, string> = {
              ...candidate.contextData,
              subject: message.subject,
              body: message.body,
              participant_name: participant.name,
            };

            const emailNotif = await nudgeNotifications.create({
              projectId: candidate.projectId,
              taskId: candidate.taskId,
              participantId,
              triggerType: candidate.triggerType,
              channel: "email",
              messageSubject: message.subject,
              messageText: message.body,
              metadata: candidate.contextData,
            });

            const emailResult = await emailService.sendTemplate(templateKey, participant.email, emailVars);

            if (emailResult.success) {
              await nudgeNotifications.markSent(emailNotif.id, emailResult.messageId);
              results.notifications.push(`${candidate.triggerType}→${participant.email}`);
            } else {
              await nudgeNotifications.markFailed(emailNotif.id, emailResult.error || "Send failed");
              results.errors.push(`${templateKey}→${participant.email}: ${emailResult.error}`);
            }
          }

          // Update task.last_reminder_at
          if (candidate.taskId) {
            await execute(
              `UPDATE trip_tasks SET last_reminder_at = NOW() WHERE id = $1`,
              [candidate.taskId]
            );
          }

          results.processed++;
        } catch (err: any) {
          console.error(`[NudgeCron] Error processing candidate:`, err?.message);
          results.errors.push(`${candidate.triggerType}/${candidate.projectTitle}: ${err?.message}`);
        }
      }
    }

    console.log(`[NudgeCron] Done: ${results.processed} processed, ${results.notifications.length} emails, ${results.errors.length} errors`);
    return results;
  },

  /**
   * Trigger a one-off event notification (e.g. trip_activated, participant_joined).
   */
  async triggerEvent(params: {
    projectId: string;
    eventType: string;
    eventText: string;
  }): Promise<void> {
    try {
      const settings = await loadNudgeSettings();
      if (!settings.NUDGE_ENABLED) return;

      const project = await queryOne<TripProjectRow>(
        `SELECT * FROM trip_projects WHERE id = $1`,
        [params.projectId]
      );
      if (!project) return;

      const participants = await query<TripParticipantRow>(
        `SELECT * FROM trip_participants WHERE project_id = $1 AND status = 'confirmed'`,
        [params.projectId]
      );

      for (const participant of participants) {
        // Dedup: same event for same participant within 20h
        const isDup = await nudgeNotifications.isDuplicate(
          params.projectId,
          undefined,
          "event",
          participant.id
        );
        if (isDup) continue;

        const message = await generateNudgeMessage({
          triggerType: "event",
          automationMode: "remind",
          tripTitle: project.title,
          tripRegion: project.region || undefined,
          participantName: participant.name,
          eventText: params.eventText,
        });

        // In-app
        await nudgeNotifications.create({
          projectId: params.projectId,
          participantId: participant.id,
          triggerType: "event",
          channel: "in_app",
          messageSubject: message.subject,
          messageText: message.body,
          metadata: { event_type: params.eventType, event_text: params.eventText },
        });

        // Email
        if (participant.email) {
          const emailNotif = await nudgeNotifications.create({
            projectId: params.projectId,
            participantId: participant.id,
            triggerType: "event",
            channel: "email",
            messageSubject: message.subject,
            messageText: message.body,
            metadata: { event_type: params.eventType },
          });

          const result = await emailService.sendTemplate("nudge_event", participant.email, {
            subject: message.subject,
            body: message.body,
            trip_slug: project.slug,
            participant_name: participant.name,
          });

          if (result.success) {
            await nudgeNotifications.markSent(emailNotif.id, result.messageId);
          } else {
            await nudgeNotifications.markFailed(emailNotif.id, result.error || "Send failed");
          }
        }
      }

      // Log event
      await eventsService.log(params.projectId, params.eventType, "system", null, {
        nudge: true,
        event_text: params.eventText,
      });
    } catch (err: any) {
      console.error("[Nudge] triggerEvent error:", err?.message);
    }
  },
};
