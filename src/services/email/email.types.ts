export interface EmailSettings {
  EMAIL_PROVIDER: string;
  EMAIL_FROM_ADDRESS: string;
  EMAIL_FROM_NAME: string;
  EMAIL_REPLY_TO: string;
  EMAIL_CC_ORGANIZER: string;
  [key: string]: string;
}

export interface EmailTemplate {
  key: string;
  subject: string;
  bodyHtml: string;
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  from: string;
  replyTo?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}
