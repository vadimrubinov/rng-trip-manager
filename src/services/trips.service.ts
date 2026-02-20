import { nanoid } from "nanoid";
import { query, queryOne, execute } from "../db/pool";
import { TripProjectRow, CreateTripRequest, ProjectStatus } from "../types";

function generateSlug(region?: string, datesStart?: string): string {
  const parts: string[] = [];
  if (region) parts.push(region.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  if (datesStart) {
    const d = new Date(datesStart);
    if (!isNaN(d.getTime())) {
      const m = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
      parts.push(m[d.getMonth()], String(d.getFullYear()));
    }
  }
  if (!parts.length) parts.push("trip");
  parts.push(nanoid(6));
  return parts.join("-");
}

export const tripsService = {
  async create(userId: string, data: CreateTripRequest): Promise<TripProjectRow> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const slug = generateSlug(data.region, data.datesStart);
        return (await queryOne<TripProjectRow>(
          `INSERT INTO trip_projects
            (slug, user_id, scout_id, title, description, cover_image_url,
             region, country, latitude, longitude,
             dates_start, dates_end, target_species, trip_type,
             budget_min, budget_max, participants_count,
             experience_level, special_requirements, itinerary, template_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
          [slug, userId, data.scoutId||null, data.title,
           data.description||null, data.coverImageUrl||null,
           data.region||null, data.country||null,
           data.latitude||null, data.longitude||null,
           data.datesStart||null, data.datesEnd||null,
           data.targetSpecies||null, data.tripType||null,
           data.budgetMin||null, data.budgetMax||null,
           data.participantsCount||1, data.experienceLevel||null,
           data.specialRequirements||null,
           data.itinerary ? JSON.stringify(data.itinerary) : "[]",
           data.templateId||null]
        ))!;
      } catch (err: any) {
        if (err?.code === "23505" && attempt < 2) continue;
        throw err;
      }
    }
    throw new Error("Failed to generate unique slug");
  },

  async list(userId: string, status?: ProjectStatus, limit = 20, offset = 0) {
    let sql = `SELECT p.*,
      (SELECT COUNT(*) FROM trip_tasks WHERE project_id = p.id)::int as tasks_total,
      (SELECT COUNT(*) FROM trip_tasks WHERE project_id = p.id AND status='completed')::int as tasks_completed
      FROM trip_projects p WHERE user_id = $1`;
    const params: any[] = [userId];
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    params.push(limit, offset);
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`;
    return query(sql, params);
  },

  async getById(id: string): Promise<TripProjectRow | null> {
    return queryOne("SELECT * FROM trip_projects WHERE id = $1", [id]);
  },

  async getBySlug(slug: string): Promise<TripProjectRow | null> {
    return queryOne("SELECT * FROM trip_projects WHERE slug = $1", [slug]);
  },

  async update(id: string, data: Partial<CreateTripRequest & {status: ProjectStatus}>): Promise<TripProjectRow | null> {
    const map: Record<string,string> = {
      title:"title", description:"description", coverImageUrl:"cover_image_url",
      region:"region", country:"country",
      latitude:"latitude", longitude:"longitude",
      datesStart:"dates_start", datesEnd:"dates_end",
      targetSpecies:"target_species", tripType:"trip_type",
      budgetMin:"budget_min", budgetMax:"budget_max",
      participantsCount:"participants_count", experienceLevel:"experience_level",
      specialRequirements:"special_requirements", status:"status",
    };
    const sets: string[] = []; const params: any[] = []; let i = 1;
    for (const [k,col] of Object.entries(map)) {
      if ((data as any)[k] !== undefined) { sets.push(`${col}=$${i}`); params.push((data as any)[k]); i++; }
    }
    if (data.itinerary !== undefined) {
      sets.push(`itinerary=$${i}`); params.push(JSON.stringify(data.itinerary)); i++;
    }
    if (!sets.length) return this.getById(id);
    params.push(id);
    return queryOne(`UPDATE trip_projects SET ${sets.join(",")} WHERE id=$${i} RETURNING *`, params);
  },

  async delete(id: string): Promise<boolean> {
    return (await execute("UPDATE trip_projects SET status='cancelled' WHERE id=$1 AND status!='cancelled'", [id])) > 0;
  },

  async verifyOwnership(projectId: string, userId: string): Promise<boolean> {
    const r = await queryOne<{user_id:string}>("SELECT user_id FROM trip_projects WHERE id=$1", [projectId]);
    return r?.user_id === userId;
  },
};
