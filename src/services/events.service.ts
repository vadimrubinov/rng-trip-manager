import { query, queryOne } from "../db/pool";
import { TripEventRow, EventActor } from "../types";

export const eventsService = {
  async log(projectId: string, eventType: string, actor: EventActor,
    actorId: string|null, payload: Record<string,any> = {},
    entityType?: string, entityId?: string): Promise<TripEventRow> {
    return (await queryOne<TripEventRow>(
      `INSERT INTO trip_events (project_id,event_type,actor,actor_id,payload,entity_type,entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [projectId, eventType, actor, actorId, JSON.stringify(payload), entityType||null, entityId||null]
    ))!;
  },

  async listByProject(projectId: string, limit=50, offset=0): Promise<TripEventRow[]> {
    return query("SELECT * FROM trip_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [projectId, limit, offset]);
  },
};
