import { pool } from "../db/pool";

export interface TripProjectRow {
  id: string;
  slug: string;
  user_id: string;
  scout_id?: string;
  title: string;
  description?: string;
  cover_image_url?: string;
  status: string; // draft, planning, active, completed, cancelled
  payment_status: string; // unpaid, processing, paid
  payment_id?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  dates_start?: string;
  dates_end?: string;
  target_species?: string;
  trip_type?: string;
  budget_min?: number;
  budget_max?: number;
  participants_count?: number;
  experience_level?: string;
  itinerary?: any;
  created_at: string;
  updated_at: string;
}

async function queryOne(sql: string, params: any[]): Promise<TripProjectRow | null> {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function queryMany(sql: string, params: any[]): Promise<TripProjectRow[]> {
  const result = await pool.query(sql, params);
  return result.rows;
}

export const tripsService = {
  async create(userId: string, data: {
    title: string;
    scoutId?: string;
    description?: string;
    region?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
    datesStart?: string;
    datesEnd?: string;
    targetSpecies?: string | string[];
    tripType?: string;
    budgetMin?: number;
    budgetMax?: number;
    participantsCount?: number;
    experienceLevel?: string;
    itinerary?: any;
  }): Promise<TripProjectRow> {
    // Generate slug from title + random suffix
    const slugBase = data.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const slug = `${slugBase}-${Math.random().toString(36).substr(2, 6)}`;

    const row = await queryOne(
      `INSERT INTO trip_projects (
        user_id, scout_id, slug, title, description, region, country, latitude, longitude,
        dates_start, dates_end, target_species, trip_type, budget_min, budget_max,
        participants_count, experience_level, itinerary, status, payment_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'draft', 'unpaid')
      RETURNING *`,
      [
        userId, data.scoutId, slug, data.title, data.description, data.region, data.country,
        data.latitude, data.longitude, data.datesStart, data.datesEnd,
        Array.isArray(data.targetSpecies) ? data.targetSpecies : (data.targetSpecies ? data.targetSpecies.split(", ") : null),
        data.tripType, data.budgetMin, data.budgetMax, data.participantsCount,
        data.experienceLevel, JSON.stringify(data.itinerary || {}),
      ]
    );
    if (!row) throw new Error("Failed to create trip project");
    return row;
  },

  async getBySlug(slug: string): Promise<TripProjectRow | null> {
    return queryOne(`SELECT * FROM trip_projects WHERE slug = $1`, [slug]);
  },

  async getById(id: string): Promise<TripProjectRow | null> {
    return queryOne(`SELECT * FROM trip_projects WHERE id = $1`, [id]);
  },

  async listByUser(userId: string): Promise<TripProjectRow[]> {
    return queryMany(
      `SELECT * FROM trip_projects WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
  },

  async countActiveByUser(userId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM trip_projects WHERE user_id = $1 AND status IN ('active', 'draft')`,
      [userId]
    );
    return result.rows[0]?.count || 0;
  },

  async updateStatus(
    slug: string,
    status: string,
    paymentData?: { payment_status?: string; payment_id?: string }
  ): Promise<TripProjectRow | null> {
    const sets: string[] = ["status = $2"];
    const params: any[] = [slug, status];
    let i = 3;

    if (paymentData?.payment_status) {
      sets.push(`payment_status = $${i}`);
      params.push(paymentData.payment_status);
      i++;
    }
    if (paymentData?.payment_id) {
      sets.push(`payment_id = $${i}`);
      params.push(paymentData.payment_id);
      i++;
    }

    return queryOne(
      `UPDATE trip_projects SET ${sets.join(", ")} WHERE slug = $1 RETURNING *`,
      params
    );
  },

  async delete(id: string): Promise<void> {
    await pool.query(`DELETE FROM trip_projects WHERE id = $1`, [id]);
  },
};

