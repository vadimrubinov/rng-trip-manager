import { Router, Request, Response } from "express";
import {
  queryPhotos,
  addCandidate,
  approvePhoto,
  rejectPhoto,
  updatePhoto,
  getPhotosForTrip,
  getStats,
  bulkApprove,
  bulkReject,
  getRegionStats,
  PhotoCategory,
  PhotoSource,
} from "../services/photo-bank.service";
import { startCollect, getCollectJob, getCollectJobs, stopCollectJob, getAvailableRegions } from "../services/photo-bank-collector.service";
import { log } from "../lib/pino-logger";

export const photoBankRouter = Router();

/** GET /stats — photo bank statistics */
photoBankRouter.get("/stats", async (_req: Request, res: Response) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err: any) {
    log.error({ err }, "photo_bank.stats.error");
    res.status(500).json({ error: "Failed to get stats" });
  }
});

/** POST /query — search photos with filters */
photoBankRouter.post("/query", async (req: Request, res: Response) => {
  try {
    const { region, country, category, species, approved, source, limit, offset, ai_score_min, ai_score_max, sort_by } = req.body;
    const result = await queryPhotos({ region, country, category, species, approved, source, limit, offset, ai_score_min, ai_score_max, sort_by });
    res.json(result);
  } catch (err: any) {
    log.error({ err }, "photo_bank.query.error");
    res.status(500).json({ error: "Failed to query photos" });
  }
});

/** POST /for-trip — get photos for trip generation */
photoBankRouter.post("/for-trip", async (req: Request, res: Response) => {
  try {
    const { region, country, targetSpecies } = req.body;
    if (!region) {
      return res.status(400).json({ error: "region is required" });
    }
    const result = await getPhotosForTrip(region, country, targetSpecies);
    res.json(result);
  } catch (err: any) {
    log.error({ err }, "photo_bank.for_trip.error");
    res.status(500).json({ error: "Failed to get trip photos" });
  }
});

/** POST /add-candidate — download from URL and add as candidate */
photoBankRouter.post("/add-candidate", async (req: Request, res: Response) => {
  try {
    const { source_url, region, country, category, species, tags, source, vendor_record_id } = req.body;

    if (!source_url) {
      return res.status(400).json({ error: "source_url is required" });
    }
    if (!source) {
      return res.status(400).json({ error: "source is required (md_raw|apify|og_image|manual|stock)" });
    }

    const photo = await addCandidate({
      source_url,
      region,
      country,
      category: category || "scenery",
      species,
      tags,
      source,
      vendor_record_id,
    });

    log.info({ id: photo.id, s3Key: photo.s3_key, source }, "photo_bank.candidate_added");
    res.json(photo);
  } catch (err: any) {
    log.error({ err, url: req.body.source_url }, "photo_bank.add_candidate.error");
    res.status(500).json({ error: `Failed to add candidate: ${err.message}` });
  }
});

/** POST /batch-add-candidates — add multiple candidates */
photoBankRouter.post("/batch-add-candidates", async (req: Request, res: Response) => {
  try {
    const { candidates } = req.body;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: "candidates array is required" });
    }

    const results: { url: string; status: string; id?: string; error?: string }[] = [];

    for (const c of candidates) {
      try {
        const photo = await addCandidate(c);
        results.push({ url: c.source_url, status: "ok", id: photo.id });
      } catch (err: any) {
        results.push({ url: c.source_url, status: "error", error: err.message });
      }
    }

    const ok = results.filter(r => r.status === "ok").length;
    log.info({ total: candidates.length, ok, errors: candidates.length - ok }, "photo_bank.batch_added");
    res.json({ total: candidates.length, ok, errors: candidates.length - ok, results });
  } catch (err: any) {
    log.error({ err }, "photo_bank.batch_add.error");
    res.status(500).json({ error: "Batch add failed" });
  }
});

/** POST /approve — approve a photo */
photoBankRouter.post("/approve", async (req: Request, res: Response) => {
  try {
    const { id, approved_by } = req.body;
    if (!id) return res.status(400).json({ error: "id is required" });

    const photo = await approvePhoto(id, approved_by || "admin");
    if (!photo) return res.status(404).json({ error: "Photo not found" });

    log.info({ id, approvedBy: approved_by }, "photo_bank.approved");
    res.json(photo);
  } catch (err: any) {
    log.error({ err }, "photo_bank.approve.error");
    res.status(500).json({ error: "Failed to approve" });
  }
});

/** POST /reject — reject and delete a photo */
photoBankRouter.post("/reject", async (req: Request, res: Response) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "id is required" });

    const deleted = await rejectPhoto(id);
    if (!deleted) return res.status(404).json({ error: "Photo not found" });

    log.info({ id }, "photo_bank.rejected");
    res.json({ ok: true });
  } catch (err: any) {
    log.error({ err }, "photo_bank.reject.error");
    res.status(500).json({ error: "Failed to reject" });
  }
});

/** POST /update — update photo metadata */
photoBankRouter.post("/update", async (req: Request, res: Response) => {
  try {
    const { id, region, country, category, species, tags } = req.body;
    if (!id) return res.status(400).json({ error: "id is required" });

    const photo = await updatePhoto(id, { region, country, category, species, tags });
    if (!photo) return res.status(404).json({ error: "Photo not found or no updates" });

    res.json(photo);
  } catch (err: any) {
    log.error({ err }, "photo_bank.update.error");
    res.status(500).json({ error: "Failed to update" });
  }
});

/** POST /bulk-approve — approve multiple photos */
photoBankRouter.post("/bulk-approve", async (req: Request, res: Response) => {
  try {
    const { ids, approved_by } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array is required" });

    const count = await bulkApprove(ids, approved_by || "admin");
    log.info({ count, approvedBy: approved_by }, "photo_bank.bulk_approved");
    res.json({ ok: true, approved: count });
  } catch (err: any) {
    log.error({ err }, "photo_bank.bulk_approve.error");
    res.status(500).json({ error: "Bulk approve failed" });
  }
});

/** POST /bulk-reject — reject (delete) multiple photos */
photoBankRouter.post("/bulk-reject", async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array is required" });

    const count = await bulkReject(ids);
    log.info({ count }, "photo_bank.bulk_rejected");
    res.json({ ok: true, deleted: count });
  } catch (err: any) {
    log.error({ err }, "photo_bank.bulk_reject.error");
    res.status(500).json({ error: "Bulk reject failed" });
  }
});

/** GET /region-stats — coverage by region and category */
photoBankRouter.get("/region-stats", async (_req: Request, res: Response) => {
  try {
    const stats = await getRegionStats();
    res.json(stats);
  } catch (err: any) {
    log.error({ err }, "photo_bank.region_stats.error");
    res.status(500).json({ error: "Failed to get region stats" });
  }
});

/** GET /available-regions — all regions from Vendors (cached 1hr) */
photoBankRouter.get("/available-regions", async (_req: Request, res: Response) => {
  try {
    const regions = await getAvailableRegions();
    res.json({ regions });
  } catch (err: any) {
    log.error({ err }, "photo_bank.available_regions.error");
    res.status(500).json({ error: "Failed to get available regions" });
  }
});

/** POST /collect-stop/:jobId — stop a running collect job */
photoBankRouter.post("/collect-stop/:jobId", async (req: Request, res: Response) => {
  const stopped = stopCollectJob(req.params.jobId);
  if (!stopped) return res.status(404).json({ error: "Job not found or not running" });
  res.json({ ok: true, jobId: req.params.jobId, status: "stopped" });
});

/** POST /collect — collect photo candidates from sources */
photoBankRouter.post("/collect", async (req: Request, res: Response) => {
  try {
    const { source, region, target, dryRun, concurrency } = req.body;

    if (!source || !["md_raw", "apify", "og_image", "all"].includes(source)) {
      return res.status(400).json({ error: "source is required (md_raw|apify|og_image|all)" });
    }
    if (!region || typeof region !== "string") {
      return res.status(400).json({ error: "region is required" });
    }

    const request = {
      source,
      region,
      target: target || 5,
      dryRun: dryRun ?? false,
      concurrency: concurrency || 2,
    };

    // Real run — fire and forget, return job ID
    const jobId = startCollect(request);
    res.json({ jobId, status: "started", message: "Use GET /api/photo-bank/collect-status/:jobId to check progress" });
  } catch (err: any) {
    log.error({ err }, "photo_bank.collect.error");
    res.status(500).json({ error: 'Collect failed: ' + err.message });
  }
});

/** GET /collect-status/:jobId — check collection job status */
photoBankRouter.get("/collect-status/:jobId", async (req: Request, res: Response) => {
  const job = getCollectJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/** GET /collect-jobs — list all collection jobs */
photoBankRouter.get("/collect-jobs", async (_req: Request, res: Response) => {
  res.json(getCollectJobs());
});
