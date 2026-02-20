import { query, queryOne, execute } from "../db/pool";
import { TripTaskRow, CreateTaskRequest, TaskStatus } from "../types";

export const tasksService = {
  async create(projectId: string, data: CreateTaskRequest): Promise<TripTaskRow> {
    return (await queryOne<TripTaskRow>(
      `INSERT INTO trip_tasks (project_id,type,title,description,deadline,sort_order,
        automation_mode,reminder_schedule,vendor_record_id,vendor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [projectId, data.type, data.title, data.description||null,
       data.deadline||null, data.sortOrder||0,
       data.automationMode||"remind", data.reminderSchedule||null,
       data.vendorRecordId||null, data.vendorName||null]
    ))!;
  },

  async createBatch(projectId: string, tasks: CreateTaskRequest[]): Promise<TripTaskRow[]> {
    const results: TripTaskRow[] = [];
    for (const t of tasks) results.push(await this.create(projectId, t));
    return results;
  },

  async listByProject(projectId: string): Promise<TripTaskRow[]> {
    return query("SELECT * FROM trip_tasks WHERE project_id=$1 ORDER BY sort_order,deadline NULLS LAST", [projectId]);
  },

  async getById(id: string): Promise<TripTaskRow | null> {
    return queryOne("SELECT * FROM trip_tasks WHERE id=$1", [id]);
  },

  async update(taskId: string, data: Partial<CreateTaskRequest & {status:TaskStatus}>): Promise<TripTaskRow | null> {
    const map: Record<string,string> = {
      type:"type", title:"title", description:"description",
      deadline:"deadline", sortOrder:"sort_order", status:"status",
      automationMode:"automation_mode", reminderSchedule:"reminder_schedule",
      vendorRecordId:"vendor_record_id", vendorName:"vendor_name",
    };
    const sets:string[]=[]; const params:any[]=[]; let i=1;
    for (const [k,col] of Object.entries(map)) {
      if ((data as any)[k] !== undefined) { sets.push(`${col}=$${i}`); params.push((data as any)[k]); i++; }
    }
    if (!sets.length) return this.getById(taskId);
    params.push(taskId);
    return queryOne(`UPDATE trip_tasks SET ${sets.join(",")} WHERE id=$${i} RETURNING *`, params);
  },

  async complete(taskId: string): Promise<TripTaskRow | null> {
    return queryOne("UPDATE trip_tasks SET status='completed',completed_at=NOW() WHERE id=$1 RETURNING *", [taskId]);
  },

  async delete(taskId: string): Promise<boolean> {
    return (await execute("DELETE FROM trip_tasks WHERE id=$1", [taskId])) > 0;
  },
};
