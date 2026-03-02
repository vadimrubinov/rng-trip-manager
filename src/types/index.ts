export type ProjectStatus = "draft" | "active" | "completed" | "cancelled" | "archived";
export type TaskStatus = "pending" | "in_progress" | "waiting_response" | "completed" | "skipped" | "overdue";
export type TaskType = "booking" | "payment" | "document" | "gear" | "travel" | "decision" | "communication" | "custom";
export type AutomationMode = "remind" | "upsell";
export type ParticipantRole = "organizer" | "participant";
export type ParticipantStatus = "invited" | "confirmed" | "declined";
export type EventActor = "user" | "system" | "agent" | "vendor";
export type LocationType = "lodge" | "river" | "lake" | "ocean" | "airport" | "city" | "port" | "other";

export interface TripImage {
  url: string;
  photographer: string;
  photographerUrl: string;
}

export interface TripImages {
  cover: TripImage | null;
  bands: (TripImage | null)[];
}

export interface TripProjectRow {
  id: string; slug: string; user_id: string; scout_id: string | null;
  title: string; status: ProjectStatus;
  description: string | null; cover_image_url: string | null;
  region: string | null; country: string | null;
  latitude: number | null; longitude: number | null;
  dates_start: string | null; dates_end: string | null;
  target_species: string[] | null; trip_type: string | null;
  budget_min: number | null; budget_max: number | null;
  participants_count: number; experience_level: string | null;
  special_requirements: string | null;
  itinerary: ItineraryDay[] | null;
  images: TripImages | null;
  template_id: string | null;
  payment_status: string; payment_id: string | null;
  created_at: string; updated_at: string;
}

export interface ItineraryDay {
  dayNumber: number;
  title: string;
  description: string;
  highlights: string[];
}

export interface TripTaskRow {
  id: string; project_id: string; type: TaskType;
  title: string; description: string | null;
  assigned_to: string | null; deadline: string | null;
  sort_order: number; status: TaskStatus; completed_at: string | null;
  automation_mode: AutomationMode;
  reminder_schedule: string | null; last_reminder_at: string | null; next_reminder_at: string | null;
  vendor_record_id: string | null; vendor_name: string | null;
  depends_on: string[] | null;
  created_at: string; updated_at: string;
}

export interface TripEventRow {
  id: string; project_id: string; event_type: string;
  actor: EventActor; actor_id: string | null;
  payload: Record<string, any>;
  entity_type: string | null; entity_id: string | null;
  created_at: string;
}

export interface TripParticipantRow {
  id: string; project_id: string; user_id: string | null;
  name: string; email: string | null;
  telegram_id: string | null; whatsapp_phone: string | null;
  preferred_channel: string; role: ParticipantRole; status: ParticipantStatus;
  invite_token: string | null; invite_sent_at: string | null; joined_at: string | null;
  created_at: string; updated_at: string;
}

export interface TripLocationRow {
  id: string; project_id: string;
  name: string; type: LocationType;
  latitude: number; longitude: number;
  day_number: number | null; sort_order: number;
  vendor_record_id: string | null; notes: string | null;
  image_url: string | null;
  created_at: string;
}

export interface CreateTripRequest {
  title: string; scoutId?: string;
  description?: string; coverImageUrl?: string;
  region?: string; country?: string;
  latitude?: number; longitude?: number;
  datesStart?: string; datesEnd?: string;
  targetSpecies?: string[]; tripType?: string;
  budgetMin?: number; budgetMax?: number;
  participantsCount?: number; experienceLevel?: string;
  specialRequirements?: string; templateId?: string;
  itinerary?: ItineraryDay[];
  images?: TripImages;
}

export interface CreateTaskRequest {
  type: TaskType; title: string; description?: string;
  deadline?: string; sortOrder?: number;
  automationMode?: AutomationMode;
  reminderSchedule?: string;
  vendorRecordId?: string; vendorName?: string;
}

export interface CreateLocationRequest {
  name: string; type: LocationType;
  latitude: number; longitude: number;
  dayNumber?: number; sortOrder?: number;
  vendorRecordId?: string; notes?: string;
  imageUrl?: string;
}

export interface GeneratePlanRequest {
  scoutId?: string;
  tripDetails?: {
    region: string; datesStart: string; datesEnd: string;
    targetSpecies: string[]; tripType: string;
    budget: number; participantsCount: number;
  };
}

export interface GeneratedPlan {
  project: Partial<CreateTripRequest>;
  tasks: CreateTaskRequest[];
  locations: CreateLocationRequest[];
}
