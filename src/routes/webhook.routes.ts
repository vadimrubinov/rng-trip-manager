import { Router, Request, Response } from "express";
import { Resend } from "resend";
import { ENV } from "../config/env";
import { vendorInquiryService } from "../services/vendor-inquiry.service";
import { classifyVendorReply } from "../services/vendor-inquiry.ai";
import { tripsService } from "../services/trips.service";
import { nudgeNotifications } from "../services/nudge/nudge.notifications";
import { emailService } from "../services/email/email.service";
import { queryOne } from "../db/pool";

const resend = new Resend(ENV.RESEND_API_KEY);

export const webhookRouter = Router();

const INQUIRY_REGEX = /^inquiry\+([a-f0-9-]{36})@bitescout\.com$/i;

webhookRouter.post("/inbound-email", async (req: Request, res: Response) => {
  try {
    // 1. Verify webhook signature
    let event: any;
    if (ENV.RESEND_WEBHOOK_SECRET) {
      try {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        event = resend.webhooks.verify({
          payload: rawBody,
          headers: {
            id: req.headers["svix-id"] as string,
            timestamp: req.headers["svix-timestamp"] as string,
            signature: req.headers["svix-signature"] as string,
          },
          webhookSecret: ENV.RESEND_WEBHOOK_SECRET,
        });
      } catch (err: any) {
        console.error("[Webhook] Signature verification failed:", err?.message);
        return res.status(401).json({ error: "Invalid signature" });
      }
    } else {
      console.warn("[Webhook] No RESEND_WEBHOOK_SECRET — skipping verification (dev mode)");
      event = req.body;
    }

    // 2. Check event type
    if (event.type !== "email.received") {
      console.log(`[Webhook] Ignoring event type: ${event.type}`);
      return res.json({ ok: true });
    }

    const data = event.data;
    console.log(`[Webhook] Inbound email from=${data.from}, to=${JSON.stringify(data.to)}, subject=${data.subject}`);

    // 3. Extract inquiry ID from to addresses
    const toAddresses: string[] = Array.isArray(data.to) ? data.to : [data.to];
    let inquiryId: string | null = null;
    for (const addr of toAddresses) {
      const match = addr.match(INQUIRY_REGEX);
      if (match) {
        inquiryId = match[1];
        break;
      }
    }

    if (!inquiryId) {
      console.log("[Webhook] No matching inquiry address in to:", toAddresses);
      return res.json({ ok: true });
    }

    // 4. Find inquiry in DB
    const inquiry = await vendorInquiryService.findById(inquiryId);
    if (!inquiry) {
      console.warn(`[Webhook] Inquiry not found: ${inquiryId}`);
      return res.json({ ok: true });
    }

    // 5. Dedup check
    const emailId = data.email_id;
    if (emailId) {
      const existing = await vendorInquiryService.findByResendInboundEmailId(emailId);
      if (existing) {
        console.log(`[Webhook] Duplicate email_id ${emailId}, skipping`);
        return res.json({ ok: true });
      }
    }

    // 6. Get email body via Resend receiving API
    let replyText: string | null = null;
    let replyHtml: string | null = null;

    if (emailId) {
      try {
        const { data: emailContent } = await resend.emails.receiving.get(emailId);
        replyText = (emailContent as any)?.text || null;
        replyHtml = (emailContent as any)?.html || null;
      } catch (err: any) {
        console.error("[Webhook] Failed to fetch email content:", err?.message);
        // Fallback: save what we have from webhook
      }
    }

    // Handle empty body
    if (!replyText && !replyHtml) {
      replyText = "(empty reply)";
    } else if (!replyText && replyHtml) {
      // Strip HTML tags for plain text fallback
      replyText = replyHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
    }

    // 7. Save reply to inquiry
    await vendorInquiryService.updateReply(inquiryId, {
      replyText,
      replyFrom: data.from || "unknown",
      replyRawHtml: replyHtml,
      resendInboundEmailId: emailId || undefined,
    });

    console.log(`[Webhook] Reply saved for inquiry ${inquiryId}`);

    // 8. AI classification (sync, ~1-2 sec)
    const classification = await classifyVendorReply({
      replyText: replyText || "",
      originalSubject: inquiry.subject || "",
      originalBody: inquiry.message_text || "",
      vendorName: inquiry.vendor_name || "Unknown vendor",
    });

    // Update inquiry with classification
    await queryOne(
      `UPDATE trip_vendor_inquiries SET reply_classification=$2, reply_summary=$3 WHERE id=$1`,
      [inquiryId, classification.classification, classification.summary]
    );

    console.log(`[Webhook] Classification: ${classification.classification} — ${classification.summary}`);

    // 9. Notification — fire-and-forget
    (async () => {
      try {
        const organizer = await queryOne(
          `SELECT * FROM trip_participants WHERE project_id=$1 AND role='organizer' LIMIT 1`,
          [inquiry.project_id]
        );
        const project = await tripsService.getById(inquiry.project_id);

        if (organizer) {
          // In-app notification
          await nudgeNotifications.create({
            projectId: inquiry.project_id,
            participantId: organizer.id,
            triggerType: "event",
            channel: "in_app",
            messageSubject: `${inquiry.vendor_name || "A vendor"} replied to your inquiry`,
            messageText: classification.summary || "You have a new reply from the operator.",
            metadata: { event_type: "vendor_reply_received", inquiry_id: inquiry.id },
          });

          // Email notification
          if (organizer.email) {
            await emailService.sendTemplate("vendor_reply_received", organizer.email, {
              vendor_name: inquiry.vendor_name || "The operator",
              trip_title: project?.title || "your trip",
              reply_summary: classification.summary || "Please check the reply.",
              trip_slug: project?.slug || "",
            });
          }

          console.log(`[Webhook] Notification sent to organizer ${organizer.id}`);
        } else {
          console.warn(`[Webhook] No organizer found for project ${inquiry.project_id}`);
        }
      } catch (err: any) {
        console.error("[Webhook] Notification error:", err?.message);
      }
    })();

    // 10. Return 200
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[Webhook] Unhandled error:", err?.message);
    // Still return 200 to prevent Resend retries on our errors
    return res.json({ ok: true });
  }
});
