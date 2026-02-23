import { pool } from "../db/pool";

function query(sql: string, params: any[] = []) {
  return pool.query(sql, params).then((r) => r.rows);
}
function queryOne(sql: string, params: any[] = []) {
  return pool.query(sql, params).then((r) => r.rows[0] || null);
}

export const vendorInquiryService = {
  async create(data: {
    projectId: string;
    vendorRecordId: string;
    vendorName: string | null;
    vendorEmail: string;
    subject: string;
    messageText: string;
    resendMessageId?: string;
  }) {
    return queryOne(
      `INSERT INTO trip_vendor_inquiries
         (project_id, vendor_record_id, vendor_name, vendor_email, subject, message_text, resend_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        data.projectId,
        data.vendorRecordId,
        data.vendorName,
        data.vendorEmail,
        data.subject,
        data.messageText,
        data.resendMessageId || null,
      ]
    );
  },

  async listByProject(projectId: string) {
    return query(
      `SELECT * FROM trip_vendor_inquiries WHERE project_id=$1 ORDER BY created_at DESC`,
      [projectId]
    );
  },

  async findById(id: string) {
    return queryOne(`SELECT * FROM trip_vendor_inquiries WHERE id=$1`, [id]);
  },

  async findByProjectAndVendor(projectId: string, vendorRecordId: string) {
    return query(
      `SELECT * FROM trip_vendor_inquiries
       WHERE project_id=$1 AND vendor_record_id=$2
       ORDER BY created_at DESC`,
      [projectId, vendorRecordId]
    );
  },

  async countTodayByProject(projectId: string): Promise<number> {
    const row = await queryOne(
      `SELECT COUNT(*)::int AS cnt FROM trip_vendor_inquiries
       WHERE project_id=$1 AND created_at >= CURRENT_DATE`,
      [projectId]
    );
    return row?.cnt || 0;
  },

  async countByProjectAndVendor(projectId: string, vendorRecordId: string): Promise<number> {
    const row = await queryOne(
      `SELECT COUNT(*)::int AS cnt FROM trip_vendor_inquiries
       WHERE project_id=$1 AND vendor_record_id=$2`,
      [projectId, vendorRecordId]
    );
    return row?.cnt || 0;
  },

  async updateStatus(id: string, status: string, replyText?: string, replyFrom?: string) {
    const fields: string[] = ["status=$2"];
    const params: any[] = [id, status];
    let idx = 3;

    if (status === "replied") {
      fields.push(`replied_at=NOW()`);
      if (replyText) {
        fields.push(`reply_text=$${idx}`);
        params.push(replyText);
        idx++;
      }
      if (replyFrom) {
        fields.push(`reply_from=$${idx}`);
        params.push(replyFrom);
        idx++;
      }
    }

    return queryOne(
      `UPDATE trip_vendor_inquiries SET ${fields.join(",")} WHERE id=$1 RETURNING *`,
      params
    );
  },

  async updateReply(id: string, data: {
    replyText: string | null;
    replyFrom: string;
    replyRawHtml?: string | null;
    resendInboundEmailId?: string;
    classification?: string | null;
    summary?: string | null;
  }) {
    return queryOne(
      `UPDATE trip_vendor_inquiries SET
         status='replied', replied_at=NOW(),
         reply_text=$2, reply_from=$3, reply_raw_html=$4,
         resend_inbound_email_id=$5, reply_classification=$6, reply_summary=$7
       WHERE id=$1 RETURNING *`,
      [
        id,
        data.replyText,
        data.replyFrom,
        data.replyRawHtml || null,
        data.resendInboundEmailId || null,
        data.classification || null,
        data.summary || null,
      ]
    );
  },

  async findByResendInboundEmailId(emailId: string) {
    return queryOne(
      `SELECT * FROM trip_vendor_inquiries WHERE resend_inbound_email_id=$1`,
      [emailId]
    );
  },
};
