import type { Secret } from '@ponctua/vault';
import { createTransport } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends transactional email. SMTP in every environment (Mailpit in development, ADR 009). */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

export function createSmtpMailer(url: Secret, from: string): Mailer {
  // The URL may carry the provider's credentials: it is revealed here only, never logged.
  const transport = createTransport(url.reveal());
  return {
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}
