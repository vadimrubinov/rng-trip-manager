import { query, queryOne, execute } from "../db/pool";
import { TripLocationRow, CreateLocationRequest } from "../types";

export const locationsService = {
  async create(projectId: string, data: CreateLocationRequest): Promise<TripLocationRow> {
    return (await queryOne<TripLocationRow>(
      `INSERT INTO trip_locations (project_id,name,type,latitude,longitude,day_number,sort_order,vendor_record_id,notes,image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [projectId, data.name, data.type||"point", data.latitude, data.longitude,
       data.dayNumber||null, data.sortOrder||0,
       data.vendorRecordId||null, data.notes||null, data.imageUrl||null]
    ))!;
  },

  async createBatch(projectId: string, locations: CreateLocationRequest[]): Promise<TripLocationRow[]> {
    const results: TripLocationRow[] = [];
    for (const loc of locations) results.push(await this.create(projectId, loc));
    return results;
  },

  async listByProject(projectId: string): Promise<TripLocationRow[]> {
    return query("SELECT * FROM trip_locations WHERE project_id=$1 ORDER BY day_number NULLS LAST, sort_order", [projectId]);
  },

  async delete(id: string): Promise<boolean> {
    return (await execute("DELETE FROM trip_locations WHERE id=$1", [id])) > 0;
  },

  async update(id: string, data: Partial<CreateLocationRequest>): Promise<TripLocationRow | null> {
    const map: Record<string,string> = {
      name:"name", type:"type", latitude:"latitude", longitude:"longitude",
      dayNumber:"day_number", sortOrder:"sort_order",
      vendorRecordId:"vendor_record_id", notes:"notes", imageUrl:"image_url",
    };
    const sets:string[]=[]; const params:any[]=[]; let i=1;
    for (const [k,col] of Object.entries(map)) {
      if ((data as any)[k] !== undefined) { sets.push(`${col}=$${i}`); params.push((data as any)[k]); i++; }
    }
    if (!sets.length) return null;
    params.push(id);
    return queryOne(`UPDATE trip_locations SET ${sets.join(",")} WHERE id=$${i} RETURNING *`, params);
  },

  async deleteByProject(projectId: string): Promise<number> {
    return execute("DELETE FROM trip_locations WHERE project_id=$1", [projectId]);
  },
};
