import { pool } from "../db/pool";
import { log } from "../lib/pino-logger";
import { ENV } from "../config/env";

// ── Pexels photo search ──

async function searchPexelsPhotos(query: string, count: number = 5): Promise<string[]> {
  const apiKey = ENV.PEXELS_API_KEY;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      query,
      per_page: String(count),
      orientation: "landscape",
      size: "medium",
    });

    const resp = await fetch(`https://api.pexels.com/v1/search?${params}`, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(10000),
    });

    const data: any = await resp.json();

    return (data.photos || []).map((p: any) => p.src?.large || p.src?.medium || p.src?.original).filter(Boolean);
  } catch (e: any) {
    log.error({ err: e?.message, query }, "enrichment.pexels_search_failed");
    return [];
  }
}

// ── Queue operations ──

export async function enqueueEnrichment(
  projectId: string,
  userId: string,
  hotelName: string,
  locationHint: string
): Promise<string> {
  // Dedup: skip if same hotel+project already pending
  const existing = await pool.query(
    `SELECT id FROM trip_enrichment_queue
     WHERE project_id = $1 AND hotel_name = $2 AND status = 'pending'`,
    [projectId, hotelName]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const result = await pool.query(
    `INSERT INTO trip_enrichment_queue (project_id, user_id, hotel_name, location_hint)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [projectId, userId, hotelName, locationHint]
  );

  log.info({ projectId, hotelName, queueId: result.rows[0].id }, "enrichment.enqueued");
  return result.rows[0].id;
}

// ── Process single enrichment job ──

async function processEnrichmentJob(job: {
  id: string;
  project_id: string;
  user_id: string;
  hotel_name: string;
  location_hint: string;
  attempts: number;
}): Promise<void> {
  const { id, project_id, hotel_name, location_hint } = job;

  try {
    // 1. Mark as processing
    await pool.query(
      `UPDATE trip_enrichment_queue SET status = 'processing', attempts = attempts + 1 WHERE id = $1`,
      [id]
    );

    // 2. Search photos via Pexels
    const photos = await searchPexelsPhotos(`${hotel_name} ${location_hint}`, 5);

    // 3. Build enriched object
    const info: Record<string, any> = { name: hotel_name };
    if (photos.length > 0) info.photos = photos;

    // 4. Update itinerary in trip_projects — replace string with object
    const projectRes = await pool.query(
      `SELECT itinerary FROM trip_projects WHERE id = $1`,
      [project_id]
    );

    if (projectRes.rows.length > 0 && projectRes.rows[0].itinerary) {
      const itinerary = projectRes.rows[0].itinerary;
      let updated = false;

      const updatedItinerary = itinerary.map((day: any) => {
        if (day.accommodation && typeof day.accommodation === "string" && day.accommodation === hotel_name) {
          updated = true;
          return { ...day, accommodation: info };
        }
        return day;
      });

      if (updated) {
        await pool.query(
          `UPDATE trip_projects SET itinerary = $1 WHERE id = $2`,
          [JSON.stringify(updatedItinerary), project_id]
        );
      }
    }

    // 5. Mark completed
    await pool.query(
      `UPDATE trip_enrichment_queue SET status = 'completed', result = $2, processed_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(info)]
    );

    log.info({ queueId: id, hotelName: hotel_name, photosCount: photos.length }, "enrichment.processed");
  } catch (e: any) {
    const newStatus = job.attempts >= 2 ? "failed" : "pending";
    await pool.query(
      `UPDATE trip_enrichment_queue SET status = $2, error = $3, processed_at = NOW() WHERE id = $1`,
      [id, newStatus, e?.message || "unknown error"]
    );
    log.error({ queueId: id, hotelName: hotel_name, err: e?.message, newStatus }, "enrichment.process_failed");
  }
}

// ── Process queue (called by cron) ──

export async function processEnrichmentQueue(): Promise<{ processed: number; errors: number }> {
  const { rows: jobs } = await pool.query(
    `SELECT id, project_id, user_id, hotel_name, location_hint, attempts
     FROM trip_enrichment_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT 10`
  );

  if (jobs.length === 0) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;

  for (const job of jobs) {
    try {
      await processEnrichmentJob(job);
      processed++;
    } catch (e: any) {
      errors++;
      log.error({ queueId: job.id, err: e?.message }, "enrichment.queue_error");
    }
  }

  return { processed, errors };
}
