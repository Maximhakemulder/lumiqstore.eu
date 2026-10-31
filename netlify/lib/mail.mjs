// Mail via SMTP (standaard Hostnet, mailbox info@lumiqstore.eu). Alles wordt gelogd in mail_log.
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { env, q, escH, publicBase, getSettings, hqUrl } from "./core.mjs";

// Twee mailboxen: "algemeen" (info@lumiqstore.eu: inloggen, catalogus, facturen, meldingen)
// en "b2b" (armand@lumiqstore.com: de B2B-mails en de inbox met reacties). Zonder B2B_MAIL_* valt b2b terug op algemeen.
export const b2bApart = () => !!(env("B2B_MAIL_USER") && env("B2B_MAIL_PASSWORD"));
export function mailEnv(account = "algemeen") {
  const p = account === "b2b" && b2bApart() ? "B2B_" : "";
  const user = env(p + "MAIL_USER");
  return {
    account: p ? "b2b" : "algemeen",
    user, pass: env(p + "MAIL_PASSWORD"), from: env(p + "MAIL_FROM", user),
    smtpHost: env(p + "SMTP_HOST", env("SMTP_HOST", "smtp.hostnet.nl")), smtpPort: Number(env(p + "SMTP_PORT", env("SMTP_PORT", "587"))),
    imapHost: env(p + "IMAP_HOST", env("IMAP_HOST", "imap.hostnet.nl")), imapPort: Number(env(p + "IMAP_PORT", env("IMAP_PORT", "993"))),
  };
}
export const mailReady = (account = "algemeen") => env("MAIL_TRANSPORT") === "capture" || (account === "b2b" && b2bApart()) || !!(env("MAIL_USER") && env("MAIL_PASSWORD"));

// Testmodus: mails worden in het geheugen bewaard in plaats van verstuurd.
export const captured = [];
function transport(m) {
  if (env("MAIL_TRANSPORT") === "capture") return { sendMail: async (msg) => { captured.push(msg); return { messageId: msg.messageId }; } };
  return nodemailer.createTransport({
    host: m.smtpHost, port: m.smtpPort, secure: m.smtpPort === 465, requireTLS: m.smtpPort !== 465,
    auth: { user: m.user, pass: m.pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
}
export function mailError(e) {
  if (e?.code === "EAUTH") return "Inloggen bij de mailserver lukt niet. Controleer MAIL_USER en MAIL_PASSWORD in Netlify.";
  if (e?.responseCode >= 500) return "De mailserver weigerde dit bericht.";
  return `Versturen lukte niet (${e?.code || e?.responseCode || "verbinding"}).`;
}

// Verstuurt één mail en logt het resultaat. Gooit niet: geeft { ok, error } terug.
export async function sendMail({ to, subject, text, html, kind, ref = "", replyTo, headers, fromName, inReplyTo, references, messageId, attachments, account = "algemeen" }) {
  if (!mailReady(account)) {
    await logMail(to, subject, kind, false, "Mail is nog niet ingesteld (MAIL_USER/MAIL_PASSWORD).", ref);
    return { ok: false, error: "Mail is nog niet ingesteld in Netlify." };
  }
  const m = mailEnv(account);
  const domain = (m.from || "lumiqstore.eu").split("@")[1] || "lumiqstore.eu";
  const id = messageId || `<${crypto.randomUUID()}@${domain}>`;
  try {
    await transport(m).sendMail({
      from: { name: fromName || "Lumiq", address: m.from || "info@lumiqstore.eu" },
      to, subject, text, html, replyTo, headers, inReplyTo, references, messageId: id, attachments,
    });
    await logMail(to, subject, kind, true, "", ref);
    return { ok: true, messageId: id };
  } catch (e) {
    const error = mailError(e);
    await logMail(to, subject, kind, false, error, ref);
    return { ok: false, error, code: e?.code, responseCode: e?.responseCode };
  }
}
async function logMail(to, subject, kind, ok, error, ref) {
  if (kind === "inlogcode") subject = "Je inlogcode: ••••••"; // codes nooit bewaren
  await q("INSERT INTO mail_log (to_email, subject, kind, ok, error, ref) VALUES ($1,$2,$3,$4,$5,$6)",
    [String(to).slice(0, 300), String(subject).slice(0, 300), kind, ok, error, String(ref || "")]).catch(() => {});
}

// Huisstijl-mail (inlogcode, meldingen, facturen): espresso met goud, zoals de website.
export function brandHtml({ title, intro = [], button, after = [], footnote = "" }) {
  const base = publicBase();
  const p = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:23px;color:#1a1612">${t}</p>`;
  const btn = button ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 18px"><tr><td style="border-radius:8px;background:#c9a15c">
<a href="${escH(button.href)}" style="display:inline-block;padding:13px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#1a1612;text-decoration:none;border-radius:8px">${escH(button.label)}</a></td></tr></table>` : "";
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(title)}</title></head>
<body style="margin:0;padding:0;background:#f3eee6">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif">
<div style="background:#1a1612;border-radius:14px 14px 0 0;padding:18px 24px"><img src="${base}/assets/lumiq-logo-mail.png" width="64" alt="Lumiq" style="display:block;border:0;width:64px;height:auto"></div>
<div style="background:#ffffff;border-radius:0 0 14px 14px;padding:26px 24px 12px">
<h1 style="margin:0 0 16px;font-size:21px;line-height:28px;color:#1a1612">${escH(title)}</h1>
${intro.map(p).join("")}${btn}${after.map(p).join("")}
</div>
<p style="margin:16px 4px;font-size:12px;line-height:18px;color:#6f665a">${footnote || "Lumiq · Draadloze tafellampen voor de horeca"}</p>
</div></body></html>`;
}

// Melding aan het team (nieuwe catalogusaanvraag, offerte, reactie …).
export async function notifyStaff(subject, lines, link = "") {
  const s = await getSettings();
  const to = s.notify?.email || env("NOTIFY_EMAIL") || mailEnv().from || env("ADMIN_EMAILS").split(",")[0].trim();
  if (!to) return { ok: false };
  const href = link ? hqUrl() + String(link).replace(/^\/hq\/?/, "") : "";
  return sendMail({
    to, subject, kind: "melding",
    text: lines.join("\n") + (href ? `\n\nOpen in Lumiq HQ: ${href}` : ""),
    html: brandHtml({ title: subject, intro: lines.map(escH), button: href ? { label: "Open in Lumiq HQ", href } : null }),
  });
}
