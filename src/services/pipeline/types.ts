/**
 * Unified Trip Generation Pipeline — Type Definitions
 * v2.0.0
 */

export type TripSource = "scout" | "raw_itinerary" | "template" | "manual";

export type GenerationStatus = "generating" | "complete" | "failed";

export type BlockName =
  | "hero"
  | "days"
  | "overview"
  | "tasks"
  | "locations"
  | "gear"
  | "season"
  | "budget"
  | "images"
  | "validate";

export interface TripContext {
  source: TripSource;
  scoutBrief?: string;
  transcript?: string;
  rawItinerary?: string;
  clientTitle?: string;
  scoutId?: string;
  tripDetails?: {
    region?: string;
    country?: string;
    datesStart?: string;
    datesEnd?: string;
    targetSpecies?: string[];
    tripType?: string;
    budget?: number;
    participantsCount?: number;
    experienceLevel?: string;
  };
}

export interface HeroData {
  title: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  datesStart: string;
  datesEnd: string;
  targetSpecies: string[];
  tripType: string;
  experienceLevel: string;
  participantsCount: number;
  budgetEstimate?: { min: number; max: number };
}

export interface SeasonData {
  summary: string;
  airTemp: { min: number; max: number; unit: string };
  waterTemp: { min: number; max: number; unit: string };
  rainfall: string;
  bestMonths: string[];
  speciesByMonth: Record<string, {
    peak: string[];
    good: string[];
    low: string[];
  }>;
}

export interface BudgetCategory {
  category: string;
  estimated: number;
  notes: string;
}

export interface BudgetBreakdown {
  categories: BudgetCategory[];
  totalEstimate: number;
  currency: string;
  perPersonNote: string;
}

export interface ImageSet {
  cover: null;
  bands: null[];
  dayPhotos: null[];
  fishPhotos: null[];
  footer: null;
  actionBand: null;
  gearBand: null;
  seasonBand: null;
  _stub: true;
}

export interface GearData {
  fishing: string[];
  clothing: string[];
  documents: string[];
  essentials: string[];
}

export interface GenerationBlocks {
  hero: boolean;
  days: boolean;
  overview: boolean;
  tasks: boolean;
  locations: boolean;
  gear: boolean;
  season: boolean;
  budget: boolean;
  images: boolean;
  validate: boolean;
}

export interface BlockEvent {
  block?: BlockName | "complete";
  status?: "complete" | "failed" | "error";
  error?: string;
}