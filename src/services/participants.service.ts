import { nanoid } from "nanoid";
import { query, queryOne, execute } from "../db/pool";
import { TripParticipantRow, ParticipantRole, ParticipantStatus } from "../types";

export const participantsService = {
  async create(projectId: string, data: {name:string; email?:string; role?:ParticipantRole; userId?:string}): Promise<TripParticipantRow> {
    const token = data.role !== "organizer" ? nanoid(20) : null;
    return (await queryOne<TripParticipantRow>(
      `INSERT INTO trip_participants (project_id,user_id,name,email,role,invite_token)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [projectId, data.userId||null, data.name, data.email||null, data.role||"participant", token]
    ))!;
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
