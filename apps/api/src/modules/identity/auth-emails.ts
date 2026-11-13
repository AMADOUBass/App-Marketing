import type { MailMessage } from './mailer.js';

export type EmailLanguage = 'fr' | 'en';
export type AuthEmailKind = 'verifyEmail' | 'resetPassword' | 'existingAccount' | 'passwordChanged';

/**
 * The language of the browser that triggered the email (Accept-Language), French by default.
 * Users do not store a language yet.
 */
export function languageOf(request: Request | undefined): EmailLanguage {
  const header = request?.headers.get('accept-language') ?? '';
  return header.trim().toLowerCase().startsWith('en') ? 'en' : 'fr';
}

interface Copy {
  subject: string;
  intro: string;
  action?: string;
  outro: string;
}

/**
 * No user-supplied text (such as the name typed at sign-up) goes into these emails: anyone can sign
 * up with someone else's address, so that text would let a stranger write into a victim's inbox.
 */
const COPY: Record<EmailLanguage, Record<AuthEmailKind, Copy>> = {
  fr: {
    verifyEmail: {
      subject: 'Confirmez votre adresse courriel — Ponctua',
      intro: 'Pour activer votre compte Ponctua, confirmez votre adresse courriel.',
      action: 'Confirmer mon adresse',
      outro:
        "Ce lien est valable 24 heures. Si vous n'avez pas créé de compte, ignorez ce courriel.",
    },
    resetPassword: {
      subject: 'Réinitialisation de votre mot de passe — Ponctua',
      intro: 'Une réinitialisation du mot de passe de votre compte Ponctua a été demandée.',
      action: 'Choisir un nouveau mot de passe',
      outro:
        "Ce lien est valable 1 heure et ne sert qu'une fois. Si vous n'avez rien demandé, ignorez ce courriel : votre mot de passe reste inchangé.",
    },
    existingAccount: {
      subject: 'Tentative de création de compte — Ponctua',
      intro:
        "Quelqu'un a essayé de créer un compte Ponctua avec votre adresse, mais vous en avez déjà un.",
      action: 'Se connecter',
      outro:
        "Si c'était vous, connectez-vous ou utilisez « Mot de passe oublié ». Sinon, vous pouvez ignorer ce courriel.",
    },
    passwordChanged: {
      subject: 'Votre mot de passe a été modifié — Ponctua',
      intro:
        'Le mot de passe de votre compte Ponctua vient d’être modifié. Toutes vos sessions ont été fermées.',
      outro:
        "Si vous n'êtes pas à l'origine de ce changement, réinitialisez votre mot de passe tout de suite.",
    },
  },
  en: {
    verifyEmail: {
      subject: 'Confirm your email address — Ponctua',
      intro: 'To activate your Ponctua account, confirm your email address.',
      action: 'Confirm my address',
      outro:
        'This link is valid for 24 hours. If you did not create an account, ignore this email.',
    },
    resetPassword: {
      subject: 'Reset your password — Ponctua',
      intro: 'A password reset was requested for your Ponctua account.',
      action: 'Choose a new password',
      outro:
        'This link is valid for 1 hour and works once. If you did not ask for it, ignore this email: your password stays the same.',
    },
    existingAccount: {
      subject: 'Sign-up attempt — Ponctua',
      intro:
        'Someone tried to create a Ponctua account with your address, but you already have one.',
      action: 'Sign in',
      outro:
        'If it was you, sign in or use “Forgot password”. Otherwise, you can ignore this email.',
    },
    passwordChanged: {
      subject: 'Your password was changed — Ponctua',
      intro:
        'The password of your Ponctua account was just changed. All your sessions were signed out.',
      outro: 'If you did not make this change, reset your password right away.',
    },
  },
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export function authEmail(
  kind: AuthEmailKind,
  language: EmailLanguage,
  to: string,
  url?: string,
): MailMessage {
  const copy = COPY[language][kind];
  const link = url && copy.action ? { label: copy.action, href: url } : null;

  const separator = language === 'fr' ? ' : ' : ': ';
  const text = [copy.intro, link ? `${link.label}${separator}${link.href}` : null, copy.outro]
    .filter(Boolean)
    .join('\n\n');
  const html = `<!doctype html>
<html lang="${language}"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>${escapeHtml(copy.intro)}</p>
${link ? `<p><a href="${escapeHtml(link.href)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(link.label)}</a></p>\n<p style="font-size:14px;color:#444">${escapeHtml(link.href)}</p>` : ''}
<p style="font-size:14px;color:#444">${escapeHtml(copy.outro)}</p>
</body></html>`;

  return { to, subject: copy.subject, text, html };
}
