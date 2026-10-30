// Website: catalogus aanvragen (lead-magneet) en offerte-aanvragen. Elke aanvraag komt binnen in HQ › Aanvragen,
// de aanvrager krijgt de catalogus direct in de mail, en een download telt mee (/api/catalogus/download?t=…).
import crypto from "node:crypto";
import { q, one, getSettings, str, cleanEmail, EMAIL_RE, randomToken, fail, publicBase, escH, env } from "./core.mjs";
import { sendMail, brandHtml, notifyStaff } from "./mail.mjs";
import { catalogusUrl } from "./b2b.mjs";

const bronVan = (b) => {
  const s = `${b.utm_source || ""} ${b.ref || ""}`.toLowerCase();
  if (/fb|facebook|instagram|meta/.test(s) || b.fbclid) return "meta";
  if (/google|gclid/.test(s) || b.gclid) return "google";
  if (/mail|nieuwsbrief|b2b/.test(s)) return "mail";
  return s.trim() ? "anders" : "website";
};
const ipHash = (ip) => (ip ? crypto.createHash("sha256").update("lq:" + ip).digest("hex").slice(0, 16) : "");
export const downloadUrl = (token) => `${publicBase()}/api/catalogus/download?t=${encodeURIComponent(token)}`;

function check(b, velden) {
  const errors = {};
  for (const [k, msg] of velden) if (!str(b[k])) errors[k] = msg;
  if (b.email && !EMAIL_RE.test(cleanEmail(b.email))) errors.email = "Vul een geldig e-mailadres in.";
  if (Object.keys(errors).length) fail(400, "Controleer de velden.", { errors });
}
async function limiet(ip) {
  const h = ipHash(ip);
  if (!h) return;
  const { n } = await one("SELECT COUNT(*)::int AS n FROM aanvragen WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '1 hour'", [h]);
  if (n >= 10) fail(429, "Te veel aanvragen. Probeer het later opnieuw.");
}
// Is dit een zaak die we al mailden? Dan telt de aanvraag bij die lead.
async function koppelLead(email) {
  const dom = email.split("@")[1] || "";
  const l = await one(`SELECT id FROM leads WHERE lower(email) = $1 OR (domain <> '' AND domain = $2) ORDER BY (lower(email) = $1) DESC LIMIT 1`, [email, dom]);
  if (l) await q(`UPDATE leads SET catalogus_at = COALESCE(catalogus_at, NOW()), status = CASE WHEN status IN ('verstuurd','opvolging_goedgekeurd','opgevolgd','nieuw','goedgekeurd','kandidaat') THEN 'interesse' ELSE status END, updated_at = NOW() WHERE id = $1`, [l.id]);
  return l?.id || null;
}

export async function aanvraagCatalogus(b, ip) {
  if (str(b["bot-field"]) || str(b.website_url)) return { ok: true, token: "", download: "/brochure/lumiq-catalogus.pdf" }; // honeypot
  const naam = str(b.naam ?? b.Naam, 120), bedrijf = str(b.zaak ?? b.Zaak ?? b.bedrijf, 160), email = cleanEmail(b.email ?? b["E-mail"]);
  const tel = str(b.telefoon ?? b.Telefoon, 40), tafels = str(b.tafels ?? b.Tafels, 60), demo = !!(b.demo === true || b.Demo === "Ja" || b.demo === "Ja" || b.demo === "1");
  check({ naam, bedrijf, email }, [["naam", "Vul je naam in."], ["bedrijf", "Vul de naam van je zaak in."], ["email", "Vul je e-mailadres in."]]);
  await limiet(ip);
  const token = randomToken(18);
  const leadId = await koppelLead(email);
  const a = await one(`INSERT INTO aanvragen (soort, naam, bedrijf, email, telefoon, tafels, demo, bron, token, lead_id, ip_hash) VALUES ('catalogus',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [naam, bedrijf, email, tel, tafels, demo, bronVan(b), token, leadId, ipHash(ip)]);
  const s = await getSettings();
  const link = downloadUrl(token);
  const voornaam = naam.split(/\s+/)[0];
  await sendMail({
    to: email, kind: "catalogus", ref: `aanvraag:${a.id}`, replyTo: s.company.email,
    subject: "Je Lumiq catalogus 2026",
    text: `Hoi ${voornaam},\n\nBedankt voor je interesse in Lumiq. Hier is de catalogus met alle 12 series en 64 modellen:\n${link}\n\n${demo ? "Je gaf aan dat je een demo wilt. We nemen binnenkort contact op om een moment te plannen.\n\n" : ""}Vragen? Reageer gewoon op deze mail of bel ${s.company.phone}.\n\nGroet,\nTeam Lumiq`,
    html: brandHtml({ title: "Je Lumiq catalogus 2026", intro: [`Hoi ${escH(voornaam)},`, "Bedankt voor je interesse in Lumiq. Hier is de catalogus met alle 12 series en 64 modellen, met maten en afwerkingen."],
      button: { label: "Download de catalogus", href: link },
      after: [demo ? "Je gaf aan dat je een demo wilt. We nemen binnenkort contact op om een moment te plannen." : "Wil je de lampen eens op je eigen tafels zien? Dan komen we graag langs voor een demo.", `Vragen? Reageer gewoon op deze mail of bel ${escH(s.company.phone)}.`] }),
  }).catch(() => {});
  if (s.catalogus?.melding !== false || demo) {
    await notifyStaff(`${demo ? "Demo + catalogus" : "Catalogus aangevraagd"}: ${bedrijf}`, [
      `${naam} van ${bedrijf} vroeg de catalogus aan.`, `E-mail: ${email}${tel ? ` · Telefoon: ${tel}` : ""}`, tafels ? `Aantal tafels: ${tafels}` : "", demo ? "Wil graag een demo in de eigen zaak." : "",
    ].filter(Boolean), `/hq/#aanvragen/${a.id}`).catch(() => {});
  }
  return { ok: true, token, download: link };
}

export async function aanvraagOfferte(b, ip) {
  if (str(b["bot-field"]) || str(b.website_url)) return { ok: true };
  const naam = [str(b.Voornaam ?? b.voornaam, 60), str(b.Achternaam ?? b.achternaam, 80)].filter(Boolean).join(" ") || str(b.naam, 120);
  const bedrijf = str(b.Zaak ?? b.zaak ?? b.bedrijf, 160), email = cleanEmail(b["E-mail"] ?? b.email);
  check({ naam, email }, [["naam", "Vul je naam in."], ["email", "Vul je e-mailadres in."]]);
  await limiet(ip);
  const tel = str(b.Telefoon ?? b.telefoon, 40), aantal = str(b.Aantal ?? b.aantal, 30), interesse = str(b.Interesse ?? b.interesse, 120), bericht = str(b.Bericht ?? b.bericht, 3000);
  const leadId = await koppelLead(email);
  if (leadId) await q("UPDATE leads SET status = CASE WHEN status IN ('klant','afspraak') THEN status ELSE 'reactie' END, reply_at = COALESCE(reply_at, NOW()), updated_at = NOW() WHERE id = $1", [leadId]);
  const a = await one(`INSERT INTO aanvragen (soort, naam, bedrijf, email, telefoon, tafels, interesse, bericht, demo, bron, token, lead_id, ip_hash) VALUES ('offerte',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [naam, bedrijf, email, tel, aantal, interesse, bericht, /demo/i.test(interesse), bronVan(b), randomToken(18), leadId, ipHash(ip)]);
  const s = await getSettings();
  await sendMail({
    to: email, kind: "offerte-bevestiging", ref: `aanvraag:${a.id}`, replyTo: s.company.email, subject: "We hebben je aanvraag ontvangen",
    text: `Hoi ${naam.split(/\s+/)[0]},\n\nBedankt voor je aanvraag${bedrijf ? ` voor ${bedrijf}` : ""}. We sturen binnen 24 uur (werkdagen) een voorstel: welke lampen, hoeveel laders en wat het kost.\n\nIntussen alvast de catalogus:\n${catalogusUrl(s)}\n\nGroet,\nTeam Lumiq\n${s.company.phone}`,
    html: brandHtml({ title: "We hebben je aanvraag ontvangen", intro: [`Hoi ${escH(naam.split(/\s+/)[0])},`, `Bedankt voor je aanvraag${bedrijf ? ` voor ${escH(bedrijf)}` : ""}. We sturen binnen 24 uur (werkdagen) een voorstel: welke lampen, hoeveel laders en wat het kost.`],
      button: { label: "Bekijk alvast de catalogus", href: catalogusUrl(s) }, after: [`Liever direct schakelen? Bel ${escH(s.company.phone)}.`] }),
  }).catch(() => {});
  await notifyStaff(`Offerteaanvraag: ${bedrijf || naam}`, [`${naam}${bedrijf ? ` van ${bedrijf}` : ""} vraagt een offerte aan.`, `E-mail: ${email}${tel ? ` · Telefoon: ${tel}` : ""}`, aantal ? `Aantal tafels/lampen: ${aantal}` : "", interesse ? `Interesse: ${interesse}` : "", bericht ? `Bericht: ${bericht}` : ""].filter(Boolean), `/hq/#aanvragen/${a.id}`).catch(() => {});
  return { ok: true };
}

export async function download(token) {
  const s = await getSettings();
  if (token) await q("UPDATE aanvragen SET downloads = downloads + 1, gedownload_at = COALESCE(gedownload_at, NOW()), updated_at = NOW() WHERE token = $1", [str(token, 64)]).catch(() => {});
  return catalogusUrl(s);
}

// HQ › Aanvragen
export async function lijst({ soort = "", status = "" } = {}) {
  const rows = await q(`SELECT a.*, l.company AS lead_bedrijf, l.status AS lead_status FROM aanvragen a LEFT JOIN leads l ON l.id = a.lead_id
    WHERE ($1 = '' OR a.soort = $1) AND ($2 = '' OR a.status = $2) ORDER BY a.created_at DESC LIMIT 500`, [soort, status]);
  const stats = await one(`SELECT
      COUNT(*) FILTER (WHERE soort = 'catalogus')::int AS catalogus,
      COUNT(*) FILTER (WHERE soort = 'catalogus' AND created_at > NOW() - INTERVAL '7 days')::int AS catalogus7,
      COUNT(*) FILTER (WHERE soort = 'catalogus' AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')::int AS catalogusVandaag,
      COUNT(*) FILTER (WHERE soort = 'catalogus' AND downloads > 0)::int AS gedownload,
      COUNT(*) FILTER (WHERE soort = 'offerte')::int AS offertes,
      COUNT(*) FILTER (WHERE soort = 'offerte' AND created_at > NOW() - INTERVAL '7 days')::int AS offertes7,
      COUNT(*) FILTER (WHERE demo)::int AS demo,
      COUNT(*) FILTER (WHERE status = 'nieuw')::int AS nieuw,
      COUNT(*) FILTER (WHERE status = 'klant')::int AS klant
    FROM aanvragen`);
  const viaMail = await one("SELECT COUNT(DISTINCT lead_id)::int AS leads, COUNT(*)::int AS kliks FROM mail_events WHERE soort = 'catalogus'");
  const perBron = await q("SELECT bron, COUNT(*)::int AS n FROM aanvragen GROUP BY bron ORDER BY n DESC");
  const dagen = await q(`WITH d AS (SELECT generate_series(0, 29) AS i), dag AS (SELECT to_char((NOW() AT TIME ZONE 'Europe/Amsterdam')::date - i, 'YYYY-MM-DD') AS dag FROM d)
    SELECT dag.dag, (SELECT COUNT(*)::int FROM aanvragen WHERE soort = 'catalogus' AND to_char(created_at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') = dag.dag) AS website,
      (SELECT COUNT(DISTINCT lead_id)::int FROM mail_events WHERE soort = 'catalogus' AND to_char(created_at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') = dag.dag) AS mail
    FROM dag ORDER BY dag.dag`);
  const mailLeads = await q(`SELECT l.id, l.company, l.city, l.category, l.phone, l.email, l.status, MIN(e.created_at) AS eerst, COUNT(*)::int AS keer
    FROM mail_events e JOIN leads l ON l.id = e.lead_id WHERE e.soort = 'catalogus' GROUP BY l.id ORDER BY eerst DESC LIMIT 200`);
  return { aanvragen: rows, stats: { ...stats, viaMail: viaMail.leads, viaMailKliks: viaMail.kliks }, perBron, dagen, mailLeads };
}
export async function bijwerken(id, b) {
  const st = ["nieuw", "gebeld", "offerte", "klant", "geen_interesse"];
  const a = await one(`UPDATE aanvragen SET status = COALESCE($2, status), notitie = COALESCE($3, notitie), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, st.includes(b.status) ? b.status : null, b.notitie !== undefined ? str(b.notitie, 2000) : null]);
  if (!a) fail(404, "Aanvraag niet gevonden.");
  return a;
}
export const isFake = () => env("MAIL_TRANSPORT") === "capture";
