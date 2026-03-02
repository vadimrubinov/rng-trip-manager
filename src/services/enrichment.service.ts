import axios from "axios";
import { pool } from "../db/pool";
import { log } from "../lib/pino-logger";
import { ENV } from "../config/env";

// ── Aggregator blocklist ──

const AGGREGATOR_DOMAINS = [
  "booking.com", "tripadvisor.com", "expedia.com", "hotels.com",
  "agoda.com", "kayak.com", "trivago.com", "priceline.com",
  "orbitz.com", "travelocity.com", "hostelworld.com", "hotwire.com",
  "trip.com", "makemytrip.com", "yatra.com", "yelp.com",
];

function isAggregatorUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return AGGREGATOR_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

// ── Find official URL ──

function findOfficialUrl(
  results: { url: string; title: string; content: string }[],
  hotelName: string
): string | undefined {
  const nonAggregator = results.filter((r) => !isAggregatorUrl(r.url));
  if (nonAggregator.length === 0) return undefined;

  // Heuristic: domain contains words from hotel name
  const nameWords = hotelName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["hotel", "inn", "resort", "lodge", "the", "and", "spa"].includes(w));

  for (const r of nonAggregator) {
    try {
      const hostname = new URL(r.url).hostname.toLowerCase();
      const matchCount = nameWords.filter((w) => hostname.includes(w)).length;
      if (matchCount > 0 && matchCount >= Math.min(nameWords.length, 2)) {
        return r.url;
      }
    } catch {}
  }

  // Fallback: title contains hotel name
  const titleMatch = nonAggregator.find((r) =>
    r.title.toLowerCase().includes(hotelName.toLowerCase().split(" ")[0])
  );
  if (titleMatch) return titleMatch.url;

  return undefined;
}

// ── Tavily search ──

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

async function tavilySearch(
  query: string,
  maxResults: number = 5,
  includeImages: boolean = false
): Promise<{ results: TavilyResult[]; answer?: string; images?: string[] }> {
  const apiKey = ENV.TAVILY_API_KEY;
  if (!apiKey) return { results: [] };

  const { data } = await axios.post(
    "https://api.tavily.com/search",
    {
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: Math.min(maxResults, 10),
      include_answer: true,
      include_images: includeImages,
    },
    { timeout: 30000 }
  );

  return {
    results: (data.results || []).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      content: (r.content || "").slice(0, 1000),
      score: r.score || 0,
    })),
    answer: data.answer || undefined,
    images: data.images || undefined,
  };
}

// ── Pexels photo search ──

async function searchPexelsPhotos(query: string, count: number = 5): Promise<string[]> {
  const apiKey = ENV.PEXELS_API_KEY;
  if (!apiKey) return [];

  try {
    const { data } = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: {
        query,
        per_page: count,
        orientation: "landscape",
        size: "medium",
      },
      timeout: 10000,
    });

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
    // Mark as processing
    await pool.query(
      `UPDATE trip_enrichment_queue SET status = 'processing', attempts = attempts + 1 WHERE id = $1`,
      [id]
    );

    // 1. Search for hotel info
    const searchQuery = `${hotel_name} hotel ${location_hint}`;
    const searchResult = await tavilySearch(searchQuery, 5, true);

    if (searchResult.results.length === 0) {
      await pool.query(
        `UPDATE trip_enrichment_queue SET status = 'completed', result = $2, processed_at = NOW() WHERE id = $1`,
        [id, JSON.stringify({ name: hotel_name, note: "no search results" })]
      );
      return;
    }

    const info: Record<string, any> = { name: hotel_name };

    // 2. Find official URL (not aggregator)
    let officialUrl = findOfficialUrl(searchResult.results, hotel_name);

    if (!officialUrl) {
      try {
        const fallback = await tavilySearch(`"${hotel_name}" official website ${location_hint}`, 3);
        if (fallback.results.length > 0) {
          officialUrl = findOfficialUrl(fallback.results, hotel_name);
        }
      } catch {}
    }

    if (officialUrl) info.url = officialUrl;

    // 3. Extract metadata from all results
    const allContent = searchResult.results.map((r) => r.content).join(" ");
    info.snippet = (searchResult.answer || searchResult.results[0].content || "").slice(0, 200);

    const ratingMatch = allContent.match(/(\d+\.?\d?)\s*(?:\/\s*5|stars?|out of 5)/i);
    if (ratingMatch) info.rating = parseFloat(ratingMatch[1]);

    const phoneMatch = allContent.match(/(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    if (phoneMatch) info.phone = phoneMatch[0];

    const addressMatch = allContent.match(
      /\d{1,5}\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Way|Highway|Hwy|Lane|Ln)[\w\s,]*\d{5}/i
    );
    if (addressMatch) info.address = addressMatch[0].trim();

    // 4. Search for photos (Pexels first, Tavily images as fallback)
    let photos = await searchPexelsPhotos(`${hotel_name} ${location_hint}`, 5);
    if (photos.length === 0 && searchResult.images && searchResult.images.length > 0) {
      photos = searchResult.images
        .filter((url: string) => {
          try {
            const u = new URL(url);
            return u.protocol === "https:" && !url.includes("favicon") && !url.includes("logo");
          } catch {
            return false;
          }
        })
        .slice(0, 5);
    }
    if (photos.length > 0) info.photos = photos;

    // 5. Update itinerary in trip_projects
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

    // 6. Mark completed
    await pool.query(
      `UPDATE trip_enrichment_queue SET status = 'completed', result = $2, processed_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(info)]
    );

    log.info({ queueId: id, hotelName: hotel_name, hasUrl: !!info.url, photosCount: photos.length }, "enrichment.processed");
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
