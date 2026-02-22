import { ENV } from "../../config/env";
import { airtable } from "../../lib/airtable";
import { renderEmail, interpolateVariables } from "./email.renderer";
import { EmailSettings, EmailResult } from "./email.types";

// Simple in-memory cache
let settingsCache: { data: EmailSettings; ts: number } | null = null;
const templateCache = new Map<string, { data: { subject: string; bodyHtml: string }; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

async function loadSettings(): Promise<EmailSettings> {
  if (settingsCache && Date.now() - settingsCache.ts < CACHE_TTL) {
    return settingsCache.data;
  }
  const raw = await airtable.getEmailSettings();
  settingsCache = { data: raw as EmailSettings, ts: Date.now() };
  return settingsCache.data;
}

async function loadTemplate(key: string): Promise<{ subject: string; bodyHtml: string } | null> {
  const cached = templateCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }
  const tpl = await airtable.getEmailTemplate(key);
  if (tpl) {
    templateCache.set(key, { data: tpl, ts: Date.now() });
  }
  return tpl;
}

async function sendViaResend(
  to: string,
  from: string,
  subject: string,
  html: string,
  replyTo?: string
): Promise<EmailResult> {
  if (!ENV.RESEND_API_KEY) {
    console.warn("[Email] RESEND_API_KEY not configured — skipping send");
    return { success: false, error: "Email not configured" };
  }

  const payload: any = { from, to: [to], subject, html };
  if (replyTo) payload.reply_to = [replyTo];

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error(`[Email] Resend ${resp.status}:`, errBody);
    return { success: false, error: `Resend ${resp.status}: ${errBody}` };
  }

  const data: any = await resp.json();
  return { success: true, messageId: data.id };
}

export const emailService = {
  /**
   * Send an email using a template from Airtable.
   * Returns result — never throws.
   */
  async sendTemplate(
    templateKey: string,
    to: string,
    variables: Record<string, string>
  ): Promise<EmailResult> {
    try {
      const [settings, template] = await Promise.all([
        loadSettings(),
        loadTemplate(templateKey),
      ]);

      if (!template) {
        return { success: false, error: `Template '${templateKey}' not found` };
      }

      // Interpolate variables into subject and body
      const subject = interpolateVariables(template.subject, variables);
      const bodyHtml = interpolateVariables(template.bodyHtml, variables);

      // Wrap in branded layout
      const html = renderEmail(bodyHtml);

      const fromAddr = `${settings.EMAIL_FROM_NAME || "BiteScout"} <${settings.EMAIL_FROM_ADDRESS || "noreply@bitescout.com"}>`;
      const replyTo = settings.EMAIL_REPLY_TO || undefined;

      return await sendViaResend(to, fromAddr, subject, html, replyTo);
    } catch (err: any) {
      console.error("[Email] sendTemplate error:", err?.message);
      return { success: false, error: err?.message || "Unknown error" };
    }
  },

  /**
   * Render a template to HTML without sending.
   */
  async renderTemplate(
    templateKey: string,
    variables: Record<string, string>
  ): Promise<{ html: string } | { error: string }> {
    try {
      const template = await loadTemplate(templateKey);
      if (!template) {
        return { error: `Template '${templateKey}' not found` };
      }

      const bodyHtml = interpolateVariables(template.bodyHtml, variables);
      const html = renderEmail(bodyHtml);
      return { html };
    } catch (err: any) {
      return { error: err?.message || "Render error" };
    }
  },

  /**
   * Load current email settings (for checking CC_ORGANIZER etc.)
   */
  loadSettings,
};
