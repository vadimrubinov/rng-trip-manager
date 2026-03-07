/**
 * Unified Trip Generation Pipeline — Source-specific Strategies
 * Copied from itinerary-planner.service.ts: fillMissingDates, parseRawDate, ensureVendorTasks
 * These are programmatic helpers (no LLM) reused by the unified pipeline.
 */

import { log } from "../../lib/pino-logger";
import { CreateTaskRequest } from "../../types";

/* ── Date Parsing (EN + RU month names) ── */

interface ParsedDay {
  dayNumber: number;
  dateRaw: string | null;
  date?: string;
  title: string;
  description: string;
  type: string;
  regionName: string;
  country: string;
  accommodation: string | null;
  vendors: string[];
  species: string[];
  keyPlaces: string[];
  transportNotes: string | null;
}

function parseRawDate(dateRaw: string): Date | null {
  if (!dateRaw) return null;

  const cleaned = dateRaw
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .replace(/\./g, " ")
    .trim();

  const MONTHS: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    январ: 0, феврал: 1, март: 2, апрел: 3, мая: 4, май: 4, июн: 5, июл: 6,
    август: 7, сентябр: 8, октябр: 9, ноябр: 10, декабр: 11,
  };

  const parts = cleaned.split(/[\s,]+/).filter(Boolean);
  let month = -1;
  let day = -1;

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (!isNaN(num)) {
      if (num > 31) continue;
      if (day === -1) day = num;
    } else {
      const lower = part.toLowerCase();
      for (const [key, val] of Object.entries(MONTHS)) {
        if (lower.startsWith(key) || key.startsWith(lower)) {
          month = val;
          break;
        }
      }
    }
  }

  if (month === -1 || day === -1) return null;

  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month, day);
  if (candidate < now) year += 1;
  return new Date(year, month, day);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function fillMissingDates<T extends { dateRaw?: string | null; date?: string }>(days: T[]): T[] {
  if (days.length === 0) return days;

  let anchorIdx = -1;
  let anchorDate: Date | null = null;

  for (let i = 0; i < days.length; i++) {
    if (days[i].dateRaw) {
      const parsed = parseRawDate(days[i].dateRaw!);
      if (parsed) {
        anchorIdx = i;
        anchorDate = parsed;
        break;
      }
    }
  }

  if (!anchorDate || anchorIdx === -1) {
    log.warn("[Pipeline] No parseable date found in itinerary — dates will be empty");
    return days;
  }

  for (let i = 0; i < days.length; i++) {
    const diff = i - anchorIdx;
    const d = new Date(anchorDate.getTime());
    d.setDate(d.getDate() + diff);
    days[i].date = toISO(d);
  }

  return days;
}

/* ── Vendor Task Coverage (programmatic) ── */

export function ensureVendorTasks(days: ParsedDay[], tasks: CreateTaskRequest[]): CreateTaskRequest[] {
  const vendorDayMap = new Map<string, ParsedDay>();
  for (const day of days) {
    for (const vendor of day.vendors) {
      const key = vendor.toLowerCase().trim();
      if (key && !vendorDayMap.has(key)) {
        vendorDayMap.set(key, day);
      }
    }
  }

  if (vendorDayMap.size === 0) return tasks;

  const coveredVendors = new Set<string>();
  for (const task of tasks) {
    if (task.vendorName) {
      coveredVendors.add(task.vendorName.toLowerCase().trim());
    }
  }

  const added: CreateTaskRequest[] = [];
  let sortOrder = tasks.length;

  for (const [vendorKey, day] of vendorDayMap) {
    if (coveredVendors.has(vendorKey)) continue;

    sortOrder++;
    const vendorName = day.vendors.find(v => v.toLowerCase().trim() === vendorKey) || vendorKey;
    const dateStr = day.date ? ` for ${day.date}` : "";

    let deadline: string | undefined;
    const tripStart = days[0]?.date;
    if (tripStart) {
      const d = new Date(tripStart);
      d.setDate(d.getDate() - 30);
      deadline = d.toISOString();
    }

    added.push({
      type: "booking",
      title: `Confirm booking with ${vendorName}`,
      description: `Confirm booking with ${vendorName}${dateStr} (Day ${day.dayNumber}).`,
      deadline,
      sortOrder,
      automationMode: "remind",
      vendorName,
    });
  }

  if (added.length > 0) {
    log.info({ added: added.map(t => t.vendorName) }, "[Pipeline] Added missing vendor tasks");
  }

  return [...tasks, ...added];
}

/* ── Title extraction from raw itinerary ── */

export function extractClientTitle(rawItinerary: string): string | undefined {
  if (!rawItinerary) return undefined;
  const firstLine = rawItinerary.trim().split("\n")[0].trim();
  // If first line looks like a title (not a day header, not too long, no day pattern)
  if (
    firstLine.length > 5 &&
    firstLine.length < 200 &&
    !/^(day\s*\d|день\s*\d)/i.test(firstLine) &&
    !/^\d+[\.\)]/.test(firstLine)
  ) {
    // Remove markdown headers
    return firstLine.replace(/^#+\s*/, "").trim() || undefined;
  }
  return undefined;
}

/* ── Day type mapping ── */

export function mapDayType(type: string): "offshore" | "rest" | "travel" {
  if (type === "fishing") return "offshore";
  if (type === "rest") return "rest";
  return "travel";
}

/* ── Deadline resolver ── */

export function resolveDeadline(tripStart: string | undefined, relativeDays: number | undefined): string | undefined {
  if (!tripStart || relativeDays === undefined) return undefined;
  const d = new Date(tripStart);
  d.setDate(d.getDate() + relativeDays);
  return d.toISOString();
}