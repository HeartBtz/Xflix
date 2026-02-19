/**
 * services/mail.js — Transactional email via nodemailer
 *
 * SMTP credentials are stored in the `settings` DB table and can be
 * configured from the Admin → Settings panel at runtime (no restart needed).
 *
 * If SMTP is not configured:
 *   - sendPasswordReset() throws, which causes auth/forgot-password to
 *     return the reset URL directly in the JSON response (development mode).
 *
 * Exported functions
 * ────────────────
 *   sendMail({ to, subject, html, text }) — generic mailer
 *   sendPasswordReset(email, username, resetUrl) — sends the reset email
 *   testSmtp()  — verifies SMTP connectivity (used by admin test endpoint)
 */
const nodemailer = require('nodemailer');
const { getSettings } = require('../db');

const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'];

async function createTransport() {
  const settings = await getSettings(SMTP_KEYS);
  if (!settings.smtp_host) throw new Error('SMTP not configured. Set it in Admin → Settings.');

  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 587,
    secure: settings.smtp_secure === 'true',
    auth: {
      user: settings.smtp_user,
      pass: settings.smtp_pass,
    },
    tls: { rejectUnauthorized: false },
  });
}

async function sendMail({ to, subject, html, text }) {
  const settings = await getSettings(['smtp_from']);
  const transport = await createTransport();
  return transport.sendMail({
    from: settings.smtp_from || 'XFlix <noreply@xflix.local>',
    to,
    subject,
    html,
    text,
  });
}

async function sendPasswordReset(email, username, resetUrl) {
  await sendMail({
    to: email,
    subject: '🔑 XFlix — Réinitialisation de votre mot de passe',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#141414;color:#fff;padding:32px;border-radius:8px">
        <h2 style="color:#e50914;margin:0 0 16px">XFlix</h2>
        <p>Bonjour <strong>${username}</strong>,</p>
        <p>Une demande de réinitialisation de mot de passe a été faite pour votre compte.</p>
        <a href="${resetUrl}" style="display:inline-block;margin:20px 0;background:#e50914;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">
          Réinitialiser mon mot de passe
        </a>
        <p style="color:#999;font-size:12px">Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
      </div>`,
    text: `Bonjour ${username},\n\nRéinitialisez votre mot de passe : ${resetUrl}\n\nCe lien expire dans 1 heure.`,
  });
}

async function testSmtp() {
  const transport = await createTransport();
  return transport.verify();
}

module.exports = { sendMail, sendPasswordReset, testSmtp };
