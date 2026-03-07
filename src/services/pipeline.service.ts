/**
 * Unified Trip Generation Pipeline — Main Orchestrator
 * v2.0.0
 *
 * Replaces planner.service.ts + itinerary-planner.service.ts
 * Generates trip block-by-block, writes to DB as each block completes,
 * streams progress via SSE (BlockEmitter).
 *
 * Feature flag: USE_PIPELINE=true on Render ENV
 */

import { log } from "../lib/pino-logger";
import { airtable, getModel } from "../lib/airtable";
import { pool } from "../db/pool";
import { query, queryOne, execute } from "../db/pool";
import { tripsService } from "./trips.service";
import { tasksService } from "./tasks.service";
import { locationsService } from "./locations.service";
import { participantsService } from "./participants.service";
import { eventsService } from "./events.service";
import { ItineraryDay, CreateTaskRequest, CreateLocationRequest } from "../types";
import {
  TripContext,
  TripSource,
  HeroData,
  SeasonData,
  BudgetBreakdown,
  ImageSet,
  GearData,
  GenerationBlocks,
  BlockName,
} from "./pipeline/types";
import {
  generateHero,
  generateDays,
  generateOverview,
  generateTasks,
  generateLocations,
  generateGear,
  generateSeason,
  generateBudget,
  generateImagesStub,
  validatePlan,
  applyCorrections,
} from "./pipeline/blocks";
import { pipelineEmitter } from "./pipeline/emitter";
import { acquireSlot, releaseSlot } from "./pipeline/queue";
import { extractClientTitle } from "./pipeline/strategies";

/* ── DB Helpers for block-by-block writes ── */

async function updateGenerationBlocks(projectId: string, block: BlockName): Promise<void> {
  await execute(
    `UPDATE trip_projects SET generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || $2::jsonb WHERE id = $1`,
    [projectId, JSON.stringify({ [block]: true })],
  );
}

async function saveHeroBlock(projectId: string, hero: HeroData): Promise<void> {
  await execute(
    `UPDATE trip_projects SET
      title = $2, region = $3, country = $4, latitude = $5, longitude = $6,
      dates_start = $7, dates_end = $8, target_species = $9, trip_type = $10,
      experience_level = $11, participants_count = $12,
      budget_min = $13, budget_max = $14,
      generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || '{"hero": true}'::jsonb
    WHERE id = $1`,
    [
      projectId,
      hero.title, hero.region, hero.country, hero.latitude, hero.longitude,
      hero.datesStart || null, hero.datesEnd || null,
      hero.targetSpecies, hero.tripType,
      hero.experienceLevel, hero.participantsCount,
      hero.budgetEstimate?.min || null, hero.budgetEstimate?.max || null,
    ],
  );
}

async function saveDaysBlock(projectId: string, days: ItineraryDay[]): Promise<void> {
  await execute(
    `UPDATE trip_projects SET itinerary = $2,
      generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || '{"days": true}'::jsonb
    WHERE id = $1`,
    [projectId, JSON.stringify(days)],
  );
}

async function saveOverviewBlock(projectId: string, description: string): Promise<void> {
  await execute(
    `UPDATE trip_projects SET description = $2,
      generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || '{"overview": true}'::jsonb
    WHERE id = $1`,
    [projectId, description],
  );
}

async function saveGearBlock(projectId: string, gear: GearData): Promise<void> {
  await execute(
    `UPDATE trip_projects SET gear = $2,
      generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || '{"gear": true}'::jsonb
    WHERE id = $1`,
    [projectId, JSON.stringify(gear)],
  );
}

async function saveSeasonBlock(projectId: string, season: SeasonData): Promise<void> {
  await execute(
    `UPDATE trip_projects SET season = $2,
      generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || '{"season": true}'::jsonb
    WHERE id = $1`,
    [projectId, JSON.stringify(season)],
  );
}

async function saveBudgetBlock(projectId: string, budget: BudgetBreakdown): Promise<void> {
  await execute(
    `UPDATE trip_projects SET budget_breakdown = $2,
      generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || '{"budget": true}'::jsonb
    WHERE id = $1`,
    [projectId, JSON.stringify(budget)],
  );
}

async function saveImagesBlock(projectId: string, images: ImageSet): Promise<void> {
  await execute(
    `UPDATE trip_projects SET images = $2,
      generation_blocks = COALESCE(generation_blocks, '{}')::jsonb || '{"images": true}'::jsonb
    WHERE id = $1`,
    [projectId, JSON.stringify(images)],
  );
}

async function updateProjectStatus(projectId: string, status: string): Promise<void> {
  await execute(
    `UPDATE trip_projects SET generation_status = $2 WHERE id = $1`,
    [projectId, status],
  );
}

/* ── Pipeline Runner ── */

async function runPipeline(projectId: string, context: TripContext): Promise<void> {
  try {
    await acquireSlot();

    const modelConfig = await getModel("trip_planner");
    const model = modelConfig.model;
    const startTime = Date.now();

    log.info({ projectId, source: context.source, model }, "[Pipeline] Starting generation");

    // Step 1: HERO
    const hero = await generateHero(context, model);
    await saveHeroBlock(projectId, hero);
    pipelineEmitter.emitBlock(projectId, { block: "hero" });
    log.info({ projectId, title: hero.title }, "[Pipeline] Hero complete");

    // Step 2: DAYS
    const days = await generateDays(context, model);
    await saveDaysBlock(projectId, days);
    pipelineEmitter.emitBlock(projectId, { block: "days" });
    log.info({ projectId, daysCount: days.length }, "[Pipeline] Days complete");

    // Step 3: Parallel batch 1 — [overview, tasks, locations, gear]
    const batch1Results = await Promise.allSettled([
      generateOverview(context, hero, days, model),
      generateTasks(context, hero, days, model),
      generateLocations(days, model),
      generateGear(hero, model),
    ]);

    // Process overview
    let overview = "";
    if (batch1Results[0].status === "fulfilled") {
      overview = batch1Results[0].value;
      await saveOverviewBlock(projectId, overview);
      pipelineEmitter.emitBlock(projectId, { block: "overview" });
    } else {
      log.error({ err: batch1Results[0].reason }, "[Pipeline] Overview block failed");
      pipelineEmitter.emitBlock(projectId, { block: "overview", status: "error" });
    }

    // Process tasks
    let tasks: CreateTaskRequest[] = [];
    if (batch1Results[1].status === "fulfilled") {
      tasks = batch1Results[1].value;
      for (const t of tasks) {
        await tasksService.create(projectId, t);
      }
      await updateGenerationBlocks(projectId, "tasks");
      pipelineEmitter.emitBlock(projectId, { block: "tasks" });
    } else {
      log.error({ err: batch1Results[1].reason }, "[Pipeline] Tasks block failed");
      pipelineEmitter.emitBlock(projectId, { block: "tasks", status: "error" });
    }

    // Process locations
    let locations: CreateLocationRequest[] = [];
    if (batch1Results[2].status === "fulfilled") {
      locations = batch1Results[2].value;
      for (const loc of locations) {
        await locationsService.create(projectId, loc);
      }
      await updateGenerationBlocks(projectId, "locations");
      pipelineEmitter.emitBlock(projectId, { block: "locations" });
    } else {
      log.error({ err: batch1Results[2].reason }, "[Pipeline] Locations block failed");
      pipelineEmitter.emitBlock(projectId, { block: "locations", status: "error" });
    }

    // Process gear
    let gear: GearData = { fishing: [], clothing: [], documents: [], essentials: [] };
    if (batch1Results[3].status === "fulfilled") {
      gear = batch1Results[3].value;
      await saveGearBlock(projectId, gear);
      pipelineEmitter.emitBlock(projectId, { block: "gear" });
    } else {
      log.error({ err: batch1Results[3].reason }, "[Pipeline] Gear block failed");
      pipelineEmitter.emitBlock(projectId, { block: "gear", status: "error" });
    }

    // Step 4: Parallel batch 2 — [season, budget, images]
    const batch2Results = await Promise.allSettled([
      generateSeason(hero, model),
      generateBudget(context, hero, days, model),
      generateImagesStub(hero, days),
    ]);

    // Process season
    let season: SeasonData = { summary: "", airTemp: { min: 0, max: 0, unit: "C" }, waterTemp: { min: 0, max: 0, unit: "C" }, rainfall: "unknown", bestMonths: [], speciesByMonth: {} };
    if (batch2Results[0].status === "fulfilled") {
      season = batch2Results[0].value;
      await saveSeasonBlock(projectId, season);
      pipelineEmitter.emitBlock(projectId, { block: "season" });
    } else {
      log.error({ err: batch2Results[0].reason }, "[Pipeline] Season block failed");
      pipelineEmitter.emitBlock(projectId, { block: "season", status: "error" });
    }

    // Process budget
    let budget: BudgetBreakdown = { categories: [], totalEstimate: 0, currency: "USD", perPersonNote: "" };
    if (batch2Results[1].status === "fulfilled") {
      budget = batch2Results[1].value;
      await saveBudgetBlock(projectId, budget);
      pipelineEmitter.emitBlock(projectId, { block: "budget" });
    } else {
      log.error({ err: batch2Results[1].reason }, "[Pipeline] Budget block failed");
      pipelineEmitter.emitBlock(projectId, { block: "budget", status: "error" });
    }

    // Process images (stub)
    if (batch2Results[2].status === "fulfilled") {
      await saveImagesBlock(projectId, batch2Results[2].value);
      pipelineEmitter.emitBlock(projectId, { block: "images" });
    } else {
      log.error({ err: batch2Results[2].reason }, "[Pipeline] Images block failed");
      pipelineEmitter.emitBlock(projectId, { block: "images", status: "error" });
    }

    // Step 5: Validate
    try {
      const validation = await validatePlan(
        { hero, days, overview, tasks, locations, gear, season, budget },
        model,
      );
      const corrected = applyCorrections(hero, days, tasks, locations, validation);
      // Save any corrections
      if (validation?.corrections && Object.keys(validation.corrections).length > 0) {
        await saveHeroBlock(projectId, corrected.hero);
        await saveDaysBlock(projectId, corrected.days);
      }
      await updateGenerationBlocks(projectId, "validate");
      pipelineEmitter.emitBlock(projectId, { block: "validate" });
    } catch (err) {
      log.warn({ err }, "[Pipeline] Validation failed — skipping");
      pipelineEmitter.emitBlock(projectId, { block: "validate", status: "error" });
    }

    // Done — set status to draft
    await updateProjectStatus(projectId, "complete");
    await execute(
      `UPDATE trip_projects SET status = 'draft' WHERE id = $1 AND status = 'generating'`,
      [projectId],
    );
    pipelineEmitter.emitBlock(projectId, { status: "complete" });

    const elapsed = Date.now() - startTime;
    log.info({ projectId, elapsed, source: context.source }, "[Pipeline] Generation complete");
  } catch (err: any) {
    log.error({ err, projectId }, "[Pipeline] Generation failed");
    await updateProjectStatus(projectId, "failed");
    pipelineEmitter.emitBlock(projectId, { status: "failed", error: err.message });
  } finally {
    releaseSlot();
  }
}

/* ── Public API ── */

export const pipelineService = {
  /**
   * Creates empty project with status='generating', acquires generation slot,
   * starts pipeline asynchronously. Returns slug immediately for frontend redirect.
   */
  async startGeneration(
    userId: string,
    context: TripContext,
    opts?: {
      scoutId?: string;
      organizerEmail?: string;
      organizerName?: string;
      requestedStatus?: string;
    },
  ): Promise<{ slug: string; projectId: string }> {
    // Extract client title for Path 2
    if (context.source === "raw_itinerary" && context.rawItinerary && !context.clientTitle) {
      context.clientTitle = extractClientTitle(context.rawItinerary);
    }

    // Create empty project with generating status
    const project = await tripsService.create(userId, {
      title: context.clientTitle || "Generating Trip...",
      scoutId: opts?.scoutId,
    });

    // Set generation status
    await execute(
      `UPDATE trip_projects SET generation_status = 'generating', generation_blocks = '{}' WHERE id = $1`,
      [project.id],
    );

    // Add organizer as participant
    await participantsService.create(project.id, {
      name: opts?.organizerName || "Organizer",
      email: opts?.organizerEmail || undefined,
      userId,
      role: "organizer",
    });

    // Log event
    await eventsService.log(project.id, "trip_generation_started", "agent", userId, {
      source: context.source,
      pipeline: "unified_v2",
    });

    // Start pipeline async (fire-and-forget)
    runPipeline(project.id, context).catch((err) => {
      log.error({ err, projectId: project.id }, "[Pipeline] Unhandled error in runPipeline");
    });

    log.info({ userId, projectId: project.id, slug: project.slug, source: context.source }, "[Pipeline] Generation started");

    return { slug: project.slug, projectId: project.id };
  },
};