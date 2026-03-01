import { log } from "../lib/pino-logger";
import { nanoid } from "nanoid";
import { query, queryOne, execute } from "../db/pool";
import { TripParticipantRow, ParticipantRole, ParticipantStatus } from "../types";
import { emailService } from "./email/email.service";
import { eventsService } from "./events.service";

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

async function sendInvitationEmail(
  participant: TripParticipantRow,
  projectId: string
): Promise<void> {
  try {
    if (!participant.email || participant.role === "organizer") return;

    // Load project
    const projResult = await queryOne<any>(
      "SELECT * FROM trip_projects WHERE id = $1",
      [projectId]
    );
    if (!projResult) return;

    // Load organizer
    const organizer = await queryOne<TripParticipantRow>(
      "SELECT * FROM trip_participants WHERE project_id = $1 AND role = 'organizer' LIMIT 1",
      [projectId]
    );

    const variables: Record<string, string> = {
      trip_title: projResult.title || "Fishing Trip",
      organizer_name: organizer?.name || "The organizer",
      destination: projResult.region || projResult.country || "TBD",
      dates: formatDates(projResult.dates_start, projResult.dates_end),
      invite_link: `https://bitescout.com/trip/${projResult.slug}?token=${participant.invite_token || ""}`,
      trip_url: `https://bitescout.com/trip/${projResult.slug}`,
    };

    const result = await emailService.sendTemplate("trip_invitation", participant.email, variables);

    // Log event
    await eventsService.log(
      projectId,
      result.success ? "email_sent" : "email_failed",
      "system",
      null,
      {
        template_key: "trip_invitation",
        to: participant.email,
        messageId: result.messageId,
        error: result.error,
      },
      "participant",
      participant.id
    );

    // Update invite_sent_at on success
    if (result.success) {
      await execute(
        "UPDATE trip_participants SET invite_sent_at = NOW() WHERE id = $1",
        [participant.id]
      );
    }

    // CC organizer if setting enabled
    if (result.success && organizer?.email) {
      try {
        const settings = await emailService.loadSettings();
        if (settings.EMAIL_CC_ORGANIZER === "true") {
          await emailService.sendTemplate("trip_invitation", organizer.email, variables);
        }
      } catch {}
    }
  } catch (err: any) {
    log.error({ err }, "[Participants] Email send error");
  }
}

export const participantsService = {
  async create(projectId: string, data: {name:string; email?:string; role?:ParticipantRole; userId?:string}): Promise<TripParticipantRow> {
    const token = data.role !== "organizer" ? nanoid(20) : null;
    const row = (await queryOne<TripParticipantRow>(
      `INSERT INTO trip_participants (project_id,user_id,name,email,role,invite_token)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [projectId, data.userId||null, data.name, data.email||null, data.role||"participant", token]
    ))!;

    // Fire-and-forget: send invitation email if participant has email
    if (data.email && data.role !== "organizer") {
      sendInvitationEmail(row, projectId).catch(() => {});
    }

    return row;
  },

  async listByProject(projectId: string): Promise<TripParticipantRow[]> {
    return query("SELECT * FROM trip_participants WHERE project_id=$1 ORDER BY role,created_at", [projectId]);
  },

  async update(id: string, data: Partial<{name:string; email:string; status:ParticipantStatus; preferredChannel:string}>): Promise<TripParticipantRow | null> {
    const sets:string[]=[]; const params:any[]=[]; let i=1;
    if (data.name!==undefined) { sets.push(`name=$${i}`); params.push(data.name); i++; }
    if (data.email!==undefined) { sets.push(`email=$${i}`); params.push(data.email); i++; }
    if (data.status!==undefined) {
      sets.push(`status=$${i}`); params.push(data.status); i++;
      if (data.status==="confirmed") sets.push("joined_at=NOW()");
    }
    if (data.preferredChannel!==undefined) { sets.push(`preferred_channel=$${i}`); params.push(data.preferredChannel); i++; }
    if (!sets.length) return null;
    params.push(id);
    return queryOne(`UPDATE trip_participants SET ${sets.join(",")} WHERE id=$${i} RETURNING *`, params);
  },

  async getByInviteToken(token: string): Promise<TripParticipantRow | null> {
    return queryOne("SELECT * FROM trip_participants WHERE invite_token = $1", [token]);
  },

  async acceptInvite(token: string, userId: string): Promise<TripParticipantRow | null> {
    return queryOne(
      `UPDATE trip_participants
       SET user_id = $1, status = 'confirmed', joined_at = NOW()
       WHERE invite_token = $2 AND status != 'declined'
       RETURNING *`,
      [userId, token]
    );
  },

  async delete(id: string): Promise<boolean> {
    return (await execute("DELETE FROM trip_participants WHERE id=$1", [id])) > 0;
  },
};
