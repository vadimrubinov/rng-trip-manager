import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/async-handler";
import { tripsService } from "../services/trips.service";
import { vendorInquiryService } from "../services/vendor-inquiry.service";
import { eventsService } from "../services/events.service";
import { generateVendorInquiry } from "../services/vendor-inquiry.ai";
import { emailService } from "../services/email/email.service";
import { airtable } from "../lib/airtable";

export const vendorRouter = Router();

function getUserId(req: Request): string | null {
  const id = req.body.clerkUserId || req.query.clerkUserId;
  return id && typeof id === "string" ? id : null;
}

// ── POST /inquiry — generate, send, save ──

vendorRouter.post("/inquiry", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "clerkUserId required" });

    const { projectId, vendorRecordId, customMessage } = req.body;
    if (!projectId || !vendorRecordId) {
      return res.status(400).json({ error: "projectId and vendorRecordId required" });
    }

    // 1. Verify ownership
    const project = await tripsService.getById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.user_id !== userId) return res.status(403).json({ error: "Not project owner" });
    if (project.status !== "active" && project.status !== "planning") {
      return res.status(400).json({ error: "Project must be active or planning" });
    }

    // 2. Rate limits from Chat_Settings
    const [maxPerDayStr, maxPerVendorStr] = await Promise.all([
      airtable.getChatSetting("VENDOR_INQUIRY_MAX_PER_PROJECT_PER_DAY"),
      airtable.getChatSetting("VENDOR_INQUIRY_MAX_PER_VENDOR_PER_TRIP"),
    ]);
    const maxPerDay = parseInt(maxPerDayStr || "5", 10);
    const maxPerVendor = parseInt(maxPerVendorStr || "1", 10);

    const [todayCount, vendorCount] = await Promise.all([
      vendorInquiryService.countTodayByProject(projectId),
      vendorInquiryService.countByProjectAndVendor(projectId, vendorRecordId),
    ]);

    if (todayCount >= maxPerDay) {
      return res.status(429).json({ error: `Daily inquiry limit reached (${maxPerDay})` });
    }
    if (vendorCount >= maxPerVendor) {
      return res.status(409).json({ error: "Inquiry already sent to this vendor for this trip" });
    }

    // 3. Lookup vendor email
    const vendor = await airtable.getVendorById(vendorRecordId);
    if (!vendor) return res.status(404).json({ error: "Vendor not found in database" });
    if (!vendor.email) return res.status(400).json({ error: "Vendor has no email on file" });

    // 4. AI generate inquiry text
    const generated = await generateVendorInquiry({
      vendorName: vendor.name,
      tripTitle: project.title,
      region: project.region || null,
      country: project.country || null,
      datesStart: project.dates_start || null,
      datesEnd: project.dates_end || null,
      targetSpecies: project.target_species ? (Array.isArray(project.target_species) ? project.target_species : [project.target_species]) : null,
      tripType: project.trip_type || null,
      participantsCount: project.participants_count || null,
      experienceLevel: project.experience_level || null,
      description: project.description || null,
      customMessage,
    });

    // 5. Save inquiry first (to get ID for reply-to)
    const inquiry = await vendorInquiryService.create({
      projectId,
      vendorRecordId,
      vendorName: vendor.name,
      vendorEmail: vendor.email,
      subject: generated.subject,
      messageText: generated.body,
    });

    // 6. Send email via Resend using template
    const replyToPattern = await airtable.getChatSetting("VENDOR_INQUIRY_REPLY_TO_PATTERN") || "inquiry+{{id}}@bitescout.com";
    const replyTo = replyToPattern.replace("{{id}}", inquiry.id);

    const emailResult = await emailService.sendTemplateWithOverrides(
      "vendor_inquiry",
      vendor.email,
      {
        subject: generated.subject,
        message_body: generated.body,
        vendor_name: vendor.name,
        trip_title: project.title,
      },
      { replyTo }
    );

    // Update inquiry with resend message ID
    if (emailResult.success && emailResult.messageId) {
      const { pool } = await import("../db/pool");
      await pool.query(
        `UPDATE trip_vendor_inquiries SET resend_message_id=$1 WHERE id=$2`,
        [emailResult.messageId, inquiry.id]
      ).catch(() => {}); // non-critical
    }

    if (!emailResult.success) {
      console.error("[VendorInquiry] Email failed:", emailResult.error);
      // Still saved in DB with status 'sent' — can retry later
    }

    // 7. Log event
    await eventsService.log(
      projectId,
      "vendor_inquiry_sent",
      "system",
      userId,
      {
        inquiryId: inquiry.id,
        vendorRecordId,
        vendorName: vendor.name,
        vendorEmail: vendor.email,
        emailSuccess: emailResult.success,
      },
      "vendor_inquiry",
      inquiry.id
    );

    return res.json({
      ok: true,
      inquiryId: inquiry.id,
      sentTo: vendor.email,
      emailSuccess: emailResult.success,
    });
  } catch (err: any) {
    console.error("[VendorInquiry] Error:", err?.message);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}));

// ── POST /inquiry/preview — generate without sending ──

vendorRouter.post("/inquiry/preview", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "clerkUserId required" });

    const { projectId, vendorRecordId, customMessage } = req.body;
    if (!projectId || !vendorRecordId) {
      return res.status(400).json({ error: "projectId and vendorRecordId required" });
    }

    const project = await tripsService.getById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.user_id !== userId) return res.status(403).json({ error: "Not project owner" });

    const vendor = await airtable.getVendorById(vendorRecordId);
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const generated = await generateVendorInquiry({
      vendorName: vendor.name,
      tripTitle: project.title,
      region: project.region || null,
      country: project.country || null,
      datesStart: project.dates_start || null,
      datesEnd: project.dates_end || null,
      targetSpecies: project.target_species ? (Array.isArray(project.target_species) ? project.target_species : [project.target_species]) : null,
      tripType: project.trip_type || null,
      participantsCount: project.participants_count || null,
      experienceLevel: project.experience_level || null,
      description: project.description || null,
      customMessage,
    });

    return res.json({
      subject: generated.subject,
      body: generated.body,
      vendorName: vendor.name,
      vendorEmail: vendor.email,
    });
  } catch (err: any) {
    console.error("[VendorInquiry Preview] Error:", err?.message);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}));

// ── GET /inquiries/:projectId — list inquiries for project ──

vendorRouter.get("/inquiries/:projectId", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.query.clerkUserId as string;
    if (!userId) return res.status(401).json({ error: "clerkUserId required" });

    const { projectId } = req.params;
    const project = await tripsService.getById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.user_id !== userId) return res.status(403).json({ error: "Not project owner" });

    const inquiries = await vendorInquiryService.listByProject(projectId);
    return res.json({ inquiries });
  } catch (err: any) {
    console.error("[VendorInquiry List] Error:", err?.message);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}));

// ── GET /inquiry/:inquiryId — single inquiry detail ──

vendorRouter.get("/inquiry/:inquiryId", asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.query.clerkUserId as string;
    if (!userId) return res.status(401).json({ error: "clerkUserId required" });

    const inquiry = await vendorInquiryService.findById(req.params.inquiryId);
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });

    // Verify ownership via project
    const project = await tripsService.getById(inquiry.project_id);
    if (!project || project.user_id !== userId) {
      return res.status(403).json({ error: "Not project owner" });
    }

    return res.json({ inquiry });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}));
