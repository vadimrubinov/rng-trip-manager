export type TriggerType = "deadline" | "countdown" | "overdue" | "event";
export type NotificationChannel = "email" | "in_app";
export type NotificationStatus = "pending" | "sent" | "failed" | "skipped";

export interface NudgeCandidate {
  projectId: string;
  projectTitle: string;
  projectSlug: string;
  taskId?: string;
  taskTitle?: string;
  triggerType: TriggerType;
  automationMode: string;
  recipientIds: string[];
  daysUntil?: number;
  contextData: Record<string, string>;
}

export interface NotificationRecord {
  id: string;
  project_id: string;
  task_id: string | null;
  participant_id: string;
  trigger_type: TriggerType;
  channel: NotificationChannel;
  status: NotificationStatus;
  scheduled_at: string;
  sent_at: string | null;
  message_subject: string | null;
  message_text: string | null;
  error: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

export interface NudgeSettings {
  NUDGE_ENABLED: boolean;
  NUDGE_DEADLINE_DAYS: number[];
  NUDGE_COUNTDOWN_DAYS: number[];
  NUDGE_OVERDUE_DAYS: number[];
  NUDGE_QUIET_HOURS_START: number;
  NUDGE_QUIET_HOURS_END: number;
  NUDGE_MAX_PER_DAY_PER_USER: number;
}

export const DEFAULT_NUDGE_SETTINGS: NudgeSettings = {
  NUDGE_ENABLED: true,
  NUDGE_DEADLINE_DAYS: [7, 3, 1],
  NUDGE_COUNTDOWN_DAYS: [30, 14, 7, 3, 1],
  NUDGE_OVERDUE_DAYS: [1, 3, 7],
  NUDGE_QUIET_HOURS_START: 22,
  NUDGE_QUIET_HOURS_END: 8,
  NUDGE_MAX_PER_DAY_PER_USER: 5,
};
