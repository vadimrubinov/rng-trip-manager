import { query, queryOne, execute } from "../../db/pool";
import { NotificationRecord, NotificationChannel, NotificationStatus, TriggerType } from "./nudge.types";

export const nudgeNotifications = {
  async create(params: {
    projectId: string;
    taskId?: string;
    participantId: string;
    triggerType: TriggerType;
    channel: NotificationChannel;
    messageSubject?: string;
    messageText?: string;
    metadata?: Record<string, any>;
  }): Promise<NotificationRecord> {
    const rows = await query<NotificationRecord>(
      `INSERT INTO trip_notifications (project_id, task_id, participant_id, trigger_type, channel, message_subject, message_text, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        params.projectId,
        params.taskId || null,
        params.participantId,
        params.triggerType,
        params.channel,
        params.messageSubject || null,
        params.messageText || null,
        JSON.stringify(params.metadata || {}),
      ]
    );
    return rows[0];
  },

  async updateStatus(id: string, status: NotificationStatus, error?: string): Promise<void> {
    const sentAt = status === "sent" ? "NOW()" : "NULL";
    await execute(
      `UPDATE trip_notifications SET status = $1, sent_at = ${status === "sent" ? "NOW()" : "sent_at"}, error = $2 WHERE id = $3`,
      [status, error || null, id]
    );
  },

  async markSent(id: string, messageId?: string): Promise<void> {
    await execute(
      `UPDATE trip_notifications SET status = 'sent', sent_at = NOW(), metadata = metadata || $1 WHERE id = $2`,
      [JSON.stringify(messageId ? { resend_message_id: messageId } : {}), id]
    );
  },

  async markFailed(id: string, error: string): Promise<void> {
    await execute(
      `UPDATE trip_notifications SET status = 'failed', error = $1 WHERE id = $2`,
      [error, id]
    );
  },

  async markSkipped(id: string, reason: string): Promise<void> {
    await execute(
      `UPDATE trip_notifications SET status = 'skipped', error = $1 WHERE id = $2`,
      [reason, id]
    );
  },

  /**
   * Check if a notification was already sent for the same project+task+trigger+participant within the last N hours.
   */
  async isDuplicate(
    projectId: string,
    taskId: string | null | undefined,
    triggerType: TriggerType,
    participantId: string,
    withinHours: number = 20
  ): Promise<boolean> {
    const row = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM trip_notifications
       WHERE project_id = $1
         AND ($2::uuid IS NULL OR task_id = $2)
         AND trigger_type = $3
         AND participant_id = $4
         AND status IN ('sent', 'pending')
         AND created_at > NOW() - INTERVAL '1 hour' * $5`,
      [projectId, taskId || null, triggerType, participantId, withinHours]
    );
    return parseInt(row?.cnt || "0", 10) > 0;
  },

  /**
   * Count notifications sent today for a participant.
   */
  async countTodayForParticipant(participantId: string): Promise<number> {
    const row = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM trip_notifications
       WHERE participant_id = $1
         AND status = 'sent'
         AND created_at > CURRENT_DATE`,
      [participantId]
    );
    return parseInt(row?.cnt || "0", 10);
  },

  /**
   * List notifications for a project.
   */
  async listByProject(projectId: string, limit: number = 50): Promise<NotificationRecord[]> {
    return query<NotificationRecord>(
      `SELECT * FROM trip_notifications WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit]
    );
  },

  /**
   * List notifications for a user across all their trips (via trip_participants.user_id).
   * Only returns sent/pending in_app notifications.
   */
  async listByUser(userId: string, limit: number = 50): Promise<(NotificationRecord & { project_title: string; project_slug: string })[]> {
    return query(
      `SELECT n.*, p.title as project_title, p.slug as project_slug
       FROM trip_notifications n
       JOIN trip_participants tp ON tp.id = n.participant_id
       JOIN trip_projects p ON p.id = n.project_id
       WHERE tp.user_id = $1
         AND n.channel = 'in_app'
         AND n.status IN ('sent', 'pending')
       ORDER BY n.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
  },

  /**
   * Count unread in_app notifications for a user.
   */
  async countUnread(userId: string): Promise<number> {
    const row = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*) as cnt
       FROM trip_notifications n
       JOIN trip_participants tp ON tp.id = n.participant_id
       WHERE tp.user_id = $1
         AND n.channel = 'in_app'
         AND n.status IN ('sent', 'pending')
         AND n.read_at IS NULL`,
      [userId]
    );
    return parseInt(row?.cnt || "0", 10);
  },

  /**
   * Mark a single notification as read.
   */
  async markAsRead(notificationId: string): Promise<void> {
    await execute(
      `UPDATE trip_notifications SET read_at = NOW() WHERE id = $1 AND read_at IS NULL`,
      [notificationId]
    );
  },

  /**
   * Mark all in_app notifications as read for a user.
   */
  async markAllAsRead(userId: string): Promise<number> {
    const result = await query<{ id: string }>(
      `UPDATE trip_notifications n
       SET read_at = NOW()
       FROM trip_participants tp
       WHERE tp.id = n.participant_id
         AND tp.user_id = $1
         AND n.channel = 'in_app'
         AND n.read_at IS NULL
       RETURNING n.id`,
      [userId]
    );
    return result.length;
  },
};
