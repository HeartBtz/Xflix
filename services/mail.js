/**
 * services/mail.js — Transactional email via nodemailer
 *
 * SMTP credentials are stored in the `settings` DB table and can be
 * configured from the Admin → Settings panel at runtime (no restart needed).
 *
 * If SMTP is not configured, createTransport() throws and the authentication
 * route still returns its generic anti-enumeration response. Reset URLs and
 * tokens are never written to logs.
 *
 * Exported functions
 * ─────────────────
 *   sendMail({ to, subject, html, text }) — generic mailer
 *   sendPasswordReset(email, username, resetUrl) — sends the reset email
 *   testSmtp() — verifies SMTP connectivity (used by admin test endpoint)
 */
'use strict';

const nodemailer = require('nodemailer');
const { getSettings } = require('../db');

const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'];

/**
 * Charge les settings SMTP depuis la DB et crée un transport nodemailer.
 * Retourne { transport, settings } pour éviter un second appel DB dans sendMail.
 *
 * Security defaults:
 *  - TLS certificates are verified. A deliberately insecure override is
 *    available only through SMTP_ALLOW_SELF_SIGNED=true for a private server.
 *  - requireTLS: true (STARTTLS) uniquement quand secure=false + port=587.
 *  - Timeouts raisonnables pour éviter les blocages.
 *  - port par défaut : 465 si secure=true, 587 sinon.
 */
async function createTransport() {
  const settings = await getSettings(SMTP_KEYS);
  if (!settings.smtp_host) {
    throw new Error('SMTP non configuré — renseignez les paramètres dans Admin → Paramètres.');
  }

  const secure = settings.smtp_secure === 'true';
  const port   = Number(settings.smtp_port) || (secure ? 465 : 587);

  const transport = nodemailer.createTransport({
    host: settings.smtp_host,
    port,
    secure,
    requireTLS: !secure,            // force STARTTLS quand secure=false
    // N'inclure auth que si les deux champs sont renseignés
    // (avec auth: { user: undefined, pass: undefined }, nodemailer v8 lève
    //  'Missing credentials for PLAIN' même sur les serveurs qui n'en ont pas besoin)
    auth: (settings.smtp_user && settings.smtp_pass)
      ? { user: settings.smtp_user, pass: settings.smtp_pass }
      : undefined,
    tls: {
      rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== 'true',
    },
    connectionTimeout: 10_000,      // 10s pour établir la connexion TCP
    greetingTimeout:   10_000,      // 10s pour le banner SMTP
    socketTimeout:     20_000,      // 20s d'inactivité max
  });

  return { transport, settings };
}

/**
 * Envoie un email générique.
 * Un seul appel DB (createTransport récupère déjà smtp_from via SMTP_KEYS).
 */
async function sendMail({ to, subject, html, text }) {
  const { transport, settings } = await createTransport();
  return transport.sendMail({
    from: settings.smtp_from || 'XFlix <noreply@xflix.local>',
    to,
    subject,
    html,
    text,
  });
}

/** Escape HTML special characters to prevent injection in email templates */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendPasswordReset(email, username, resetUrl) {
  const safeUser = escapeHtml(username);
  const safeUrl  = encodeURI(resetUrl);  // sanitise URL (preserves valid chars)
  return sendMail({
    to: email,
    subject: '🔑 XFlix — Réinitialisation de votre mot de passe',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#141414;color:#fff;padding:32px;border-radius:8px">
        <h2 style="color:#e50914;margin:0 0 16px">XFlix</h2>
        <p>Bonjour <strong>${safeUser}</strong>,</p>
        <p>Une demande de réinitialisation de mot de passe a été faite pour votre compte.</p>
        <a href="${safeUrl}" style="display:inline-block;margin:20px 0;background:#e50914;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">
          Réinitialiser mon mot de passe
        </a>
        <p style="color:#999;font-size:12px">Ce lien expire dans 1 heure.<br>Si vous n'avez pas fait cette demande, ignorez cet email.</p>
      </div>`,
    text: `Bonjour ${username},\n\nRéinitialisez votre mot de passe : ${resetUrl}\n\nCe lien expire dans 1 heure.`,
  });
}

/**
 * Vérifie la connectivité SMTP (utilisé par POST /admin/settings/test-smtp).
 * Retourne true si le serveur accepte la connexion et l'authentification.
 */
async function testSmtp() {
  const { transport } = await createTransport();
  return transport.verify();
}

module.exports = { sendMail, sendPasswordReset, testSmtp };
