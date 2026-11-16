// B2B-verkoop horeca: scout (Outscraper/Google Maps) → research (algemeen mailadres, MX-check, AI-openingszin)
// → goedkeuren in HQ → tick verstuurt binnen verzendtijden en daglimiet → opvolging → inbox-scan (reacties/bounces)
// → één klik afmelden. Elke mail bevat de catalogus; een klik daarop telt als "catalogus gedownload".
// Gebaseerd op de B2B-machine van Sitemaker HQ.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { ImapFlow } from "imapflow";
import { env, q, one, getSettings, getState, saveSetting, str, cleanEmail, EMAIL_RE, domainOf, normUrl, dayKey, hourAms, publicBase, escH, fail, audit } from "./core.mjs";
import { sendMail, mailEnv, mailReady, notifyStaff } from "./mail.mjs";
import { claude, aiReady } from "./ai.mjs";

export const LEAD_STATUSES = ["kandidaat", "nieuw", "goedgekeurd", "verstuurd", "opvolging_goedgekeurd", "opgevolgd", "interesse", "reactie", "afspraak", "klant", "afgemeld", "overgeslagen", "fout"];
export const scoutReady = () => !!env("OUTSCRAPER_API_KEY");
export { aiReady };

const FREEMAIL = /@(gmail|hotmail|outlook|live|yahoo|icloud|me|ziggo|kpnmail|planet|home|xs4all|kpnplanet|hetnet|casema|chello|upcmail)\./i;
const GENERIC = /^(info|contact|hallo|hello|mail|post|office|welkom|administratie|algemeen|receptie|reception|frontoffice|service|verkoop|sales|team|kantoor|reserveren|reserveringen|reservations?|reservering|booking|bookings|events?|evenementen|horeca|restaurant|hotel|bar|keuken|management|manager|inkoop|groepen|zakelijk|feest|feesten|catering)([.\-_]?[a-z0-9]*)?@/i;

// ---------------------------------------------------------------- afmelden
const sig = (s) => crypto.createHmac("sha256", env("AUTH_SECRET", "lumiq-local-dev")).update(s).digest("base64url").slice(0, 24);
export const unsubUrl = (id) => `${publicBase()}/api/b2b/afmelden?l=${id}&t=${sig(`unsub:${id}`)}`;
export function checkUnsub(id, t) {
  const a = Buffer.from(String(t || "")), b = Buffer.from(sig(`unsub:${id}`));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export async function unsubscribe(id) {
  const l = await one("UPDATE leads SET status = 'afgemeld', unsub_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *", [id]);
  if (l?.email) await q("INSERT INTO suppressions (email, reason) VALUES ($1, 'afgemeld') ON CONFLICT DO NOTHING", [l.email.toLowerCase()]);
  return !!l;
}

// ---------------------------------------------------------------- meten: links, opens en de catalogus
export const catalogusUrl = (s) => publicBase() + (s?.catalogus?.url || "/brochure/lumiq-catalogus.pdf");
const trackSig = (s) => sig(`trk:${s}`).slice(0, 22);
export const trackLink = (leadId, mail, url) => { const u = Buffer.from(url).toString("base64url"); return `${publicBase()}/api/t/k?l=${leadId}&m=${mail}&u=${u}&s=${trackSig(`${leadId}:${mail}:${u}`)}`; };
export const trackPixel = (leadId, mail) => `${publicBase()}/api/t/o?l=${leadId}&m=${mail}&s=${trackSig(`${leadId}:${mail}:o`)}`;
export function checkTrack({ l, m, u, s }) {
  const want = trackSig(u !== undefined ? `${l}:${m}:${u}` : `${l}:${m}:o`);
  const a = Buffer.from(String(s || "")), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Binnen 60 s na verzenden of van bekende scanners telt niet (virusscanners openen alles meteen).
const SCANNER = /bot|crawl|spider|preview|scanner|safelinks|barracuda|mimecast|proofpoint|curl|python|go-http|headless/i;
export async function recordTrack({ l, m, u, ua = "" }) {
  const lead = Number(l); if (!lead || SCANNER.test(ua)) return false;
  const mail = m === "opvolging" ? "opvolging" : "eerste";
  const sent = await one("SELECT MAX(created_at) AS at FROM mail_log WHERE ref = $1 AND kind = $2 AND ok", [`lead:${lead}`, `b2b-${mail}`]);
  if (!sent?.at || Date.now() - new Date(sent.at).getTime() < 60000) return false;
  const url = u !== undefined ? str(Buffer.from(String(u), "base64url").toString(), 500) : "";
  const isCat = /\.pdf(\?|$)/i.test(url) || /brochure|catalogus/i.test(url);
  await q("INSERT INTO mail_events (lead_id, mail, soort, url) VALUES ($1,$2,$3,$4)", [lead, mail, u === undefined ? "open" : isCat ? "catalogus" : "klik", url]).catch(() => {});
  if (isCat) {
    const l2 = await one(`UPDATE leads SET catalogus_at = COALESCE(catalogus_at, NOW()),
        status = CASE WHEN status IN ('verstuurd','opvolging_goedgekeurd','opgevolgd') THEN 'interesse' ELSE status END, updated_at = NOW()
      WHERE id = $1 RETURNING *, (xmax = 0) AS nieuw`, [lead]);
    if (l2 && (await one("SELECT COUNT(*)::int AS n FROM mail_events WHERE lead_id = $1 AND soort = 'catalogus'", [lead])).n === 1) {
      const s = await getSettings();
      if (s.catalogus?.melding !== false) await notifyStaff(`Catalogus geopend: ${l2.company}`, [`${l2.company}${l2.city ? " (" + l2.city + ")" : ""} opende de catalogus vanuit de mail.`, "Goed moment om te bellen" + (l2.phone ? `: ${l2.phone}` : "."), ], `/hq/#b2b/lead/${lead}`).catch(() => {});
    }
  }
  return true;
}

// ---------------------------------------------------------------- opstellen
function afzender(s) {
  const co = s.company || {};
  return [`${s.b2b.senderName || co.name || "Lumiq"} | Lumiq`.replace(/^Lumiq \| Lumiq$/, "Lumiq"), s.b2b.senderRole || "", [co.phone, s.b2b.senderEmail, (co.website || "").replace(/^https?:\/\//, "")].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
}
// Handtekening als afbeelding (HTML-mail); de tekstversie houdt de gewone afzenderregels.
function handtekeningHtml(s) {
  const co = s.company || {};
  const src = String(s.b2b.handtekening || "");
  if (!src) return "";
  const url = /^https?:/.test(src) ? src : publicBase() + src;
  const site = co.website || publicBase();
  const tel = String(co.phone || "").replace(/[^\d+]/g, "");
  const links = [co.website ? `<a href="${escH(site)}" style="color:#8a6534;text-decoration:none">${escH(site.replace(/^https?:\/\//, ""))}</a>` : "",
    s.b2b.senderEmail ? `<a href="mailto:${escH(s.b2b.senderEmail)}" style="color:#8a6534;text-decoration:none">${escH(s.b2b.senderEmail)}</a>` : "",
    tel ? `<a href="tel:${escH(tel)}" style="color:#8a6534;text-decoration:none">${escH(co.phone)}</a>` : ""].filter(Boolean).join(" &nbsp;·&nbsp; ");
  return `<a href="${escH(site)}" style="text-decoration:none"><img src="${escH(url)}" width="480" alt="${escH(afzender(s).replace(/\n/g, " · "))}" style="display:block;width:100%;max-width:480px;height:auto;border:0;border-radius:12px"></a>${links ? `<p style="margin:8px 0 0;font-size:12px;line-height:18px">${links}</p>` : ""}`;
}
export function fillTemplate(tpl, lead, s) {
  const map = {
    bedrijf: lead.company || "jullie zaak", plaats: lead.city || "", afzender: afzender(s), naam: s.b2b.senderName || "",
    intro: lead.intro ? lead.intro.trim() + " " : "", catalogus: catalogusUrl(s), website: publicBase(), telefoon: s.company?.phone || "",
  };
  return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}
export function compose(lead, kind, s) {
  const t = s.b2b.templates[kind === "opvolging" ? "opvolging" : "eerste"];
  const subject = fillTemplate(t.subject, lead, s).slice(0, 200);
  let body = fillTemplate(t.body, lead, s).replace(/^- /gm, "• ");
  // De catalogus hoort in elke mail; staat hij er niet in, dan net voor de groet.
  if (!body.includes(catalogusUrl(s))) body = body.replace(/\n\n(Groet|Met vriendelijke groet)/, `\n\nBekijk de catalogus:\n${catalogusUrl(s)}\n\n$1`);
  body += `\n\n--\nGeen berichten meer van ons? Afmelden: ${unsubUrl(lead.id)}`;
  return { subject, body };
}
function voetHtml(voet) {
  return voet.split("\n").map((r) => {
    const m = r.match(/^(.*?)(?:Hier a|A)fmelden:\s*(https?:\/\/\S+)\s*$/);
    return m ? `${escH(m[1])}<a href="${escH(m[2])}" style="color:#6f665a;text-decoration:underline">Afmelden</a>` : escH(r);
  }).join("<br>");
}
export function textToHtml(text, meet = null, s = null) {
  const cat = s ? catalogusUrl(s) : "";
  const linkify = (x) => escH(x).replace(/https?:\/\/[^\s<]+/g, (u) => {
    const echt = u.replace(/&amp;/g, "&");
    const href = meet?.kliks && !echt.includes("/api/b2b/afmelden") ? trackLink(meet.leadId, meet.mail, echt) : echt;
    return `<a href="${escH(href)}" style="color:#8a6534">${u}</a>`;
  });
  const pixel = meet?.opens ? `<img src="${escH(trackPixel(meet.leadId, meet.mail))}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : "";
  const [hoofd, ...rest] = text.split(/\n\n--\n/);
  const voet = rest.join("\n\n--\n");
  const blokken = hoofd.split(/\n\n/).map((p) => {
    const regels = p.split("\n");
    const knop = cat ? regels.findIndex((r) => r.trim() === cat) : -1;
    if (knop >= 0) {
      const href = meet?.kliks ? trackLink(meet.leadId, meet.mail, cat) : cat;
      const tekst = regels.filter((_, i) => i !== knop).join("\n");
      return `${tekst ? `<p style="margin:0 0 12px">${linkify(tekst).replace(/\n/g, "<br>")}</p>` : ""}<p style="margin:4px 0 18px"><a href="${escH(href)}" style="display:inline-block;background:#1a1612;color:#EBCC92;font-weight:bold;text-decoration:none;padding:14px 24px;border-radius:8px">Bekijk de catalogus</a></p>`;
    }
    if (regels.length > 1 && regels.slice(1).every((r) => /^[•-] /.test(r.trim()))) return `<p style="margin:0 0 12px">${linkify(regels[0])}<br>${regels.slice(1).map(linkify).join("<br>")}</p>`;
    // Groet + afzender → groet + handtekening-afbeelding
    const af = s ? afzender(s) : "";
    const sig = s ? handtekeningHtml(s) : "";
    if (sig && af && p.endsWith(af)) {
      const groet = p.slice(0, -af.length).trim();
      return `${groet ? `<p style="margin:0 0 12px">${escH(groet).replace(/\n/g, "<br>")}</p>` : ""}<div style="margin:0 0 12px">${sig}</div>`;
    }
    return `<p style="margin:0 0 12px">${linkify(p).replace(/\n/g, "<br>")}</p>`;
  });
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"></head><body style="margin:0;padding:12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#1a1612">
${blokken.join("")}${voet ? `<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:#6f665a">${voetHtml(voet)}</p>` : ""}${pixel}</body></html>`;
}

// Dagen waarop gemaild en gezocht wordt (0 = zondag). Standaard maandag t/m zaterdag (keuze Maxim).
export const verzendDag = (s, wd) => (s.b2b.sendDays || [1, 2, 3, 4, 5, 6]).includes(wd);
export function perUurVan(b2b) {
  const [van, tot] = b2b.sendHours || [8, 17];
  const vast = Number(b2b.perUur || 0);
  return vast > 0 ? vast : Math.max(1, Math.ceil(Number(b2b.dailyMax || 20) / Math.max(1, tot - van)));
}

// ---------------------------------------------------------------- versturen (vanuit tick)
const fromName = (s) => `${s.b2b.senderName || ""} | Lumiq`.replace(/^ \| /, "");
export async function sendBatch({ max = 3, budgetMs = 9000 } = {}) {
  if (!mailReady("b2b")) return { skipped: "mail" };
  const s = await getSettings();
  const now = new Date();
  const wd = new Date(dayKey(now) + "T12:00:00Z").getUTCDay();
  const [from, to] = s.b2b.sendHours || [8, 17];
  if (env("B2B_ANY_TIME") !== "1" && (!verzendDag(s, wd) || hourAms(now) < from || hourAms(now) >= to)) return { skipped: "buiten verzendtijd" };
  const [{ n: today }] = await q("SELECT COUNT(*)::int AS n FROM mail_log WHERE kind LIKE 'b2b-%' AND ok AND created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')");
  let room = Math.max(0, Number(s.b2b.dailyMax || 20) - today);
  if (!room) return { skipped: "daglimiet" };
  const [{ n: ditUur }] = await q("SELECT COUNT(*)::int AS n FROM mail_log WHERE kind LIKE 'b2b-%' AND ok AND created_at >= (date_trunc('hour', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')");
  room = Math.min(room, Math.max(0, perUurVan(s.b2b) - ditUur));
  if (!room) return { skipped: "uurlimiet" };
  // Gelijk verdeeld: de tick draait elke 5 minuten, dus per ronde hooguit (per uur ÷ 12) mails. Bij 100/dag = 1 mail per 5 min.
  room = Math.min(room, Math.max(1, Math.ceil(perUurVan(s.b2b) / 12)));
  const started = Date.now();
  const todo = await q(`SELECT * FROM leads WHERE status IN ('goedgekeurd','opvolging_goedgekeurd') AND email IS NOT NULL ORDER BY updated_at LIMIT $1`, [Math.min(max, room)]);
  let sent = 0, failed = 0;
  for (const lead of todo) {
    if (Date.now() - started > budgetMs) break;
    if (await one("SELECT 1 FROM suppressions WHERE email = $1", [lead.email.toLowerCase()])) { await q("UPDATE leads SET status = 'afgemeld', updated_at = NOW() WHERE id = $1", [lead.id]); continue; }
    const kind = lead.status === "opvolging_goedgekeurd" ? "opvolging" : "eerste";
    const { subject, body } = compose(lead, kind, s);
    const res = await sendMail({
      to: lead.email, subject, text: body, kind: `b2b-${kind}`, ref: `lead:${lead.id}`, fromName: fromName(s), account: "b2b",
      html: textToHtml(body, { leadId: lead.id, mail: kind, opens: s.b2b.meten?.opens !== false, kliks: s.b2b.meten?.kliks !== false }, s),
      headers: { "List-Unsubscribe": `<${unsubUrl(lead.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      inReplyTo: kind === "opvolging" ? lead.message_id || undefined : undefined,
      references: kind === "opvolging" ? lead.message_id || undefined : undefined,
    });
    if (res.ok) {
      sent++;
      if (kind === "opvolging") await q("UPDATE leads SET status = 'opgevolgd', followup_at = NOW(), followup_id = $2, error = '', updated_at = NOW() WHERE id = $1", [lead.id, res.messageId]);
      else await q("UPDATE leads SET status = 'verstuurd', sent_at = NOW(), sent_subject = $2, message_id = $3, error = '', updated_at = NOW() WHERE id = $1", [lead.id, subject, res.messageId]);
    } else {
      failed++;
      if (res.code === "EAUTH" || [421, 450, 451, 452].includes(res.responseCode)) { await q("UPDATE leads SET error = $2 WHERE id = $1", [lead.id, res.error]); break; }
      await q("UPDATE leads SET status = 'fout', error = $2, updated_at = NOW() WHERE id = $1", [lead.id, res.error]);
    }
    await new Promise((r) => setTimeout(r, env("MAIL_TRANSPORT") === "capture" ? 0 : 1500 + Math.random() * 1500));
  }
  return { sent, failed };
}

// Opvolging: na followupDays zonder reactie. Automatisch goedgekeurd als autoGoedkeuren aan staat, anders klaar in HQ.
export async function klaarVoorOpvolging() {
  const s = await getSettings();
  return q(`SELECT * FROM leads WHERE status = 'verstuurd' AND reply_at IS NULL AND sent_at < NOW() - ($1 || ' days')::interval ORDER BY sent_at LIMIT 500`, [String(Number(s.b2b.followupDays || 5))]);
}
export async function runOpvolging() {
  const s = await getSettings();
  if (!s.b2b.autoGoedkeuren) return { handmatig: true };
  const r = await q(`UPDATE leads SET status = 'opvolging_goedgekeurd', updated_at = NOW() WHERE status = 'verstuurd' AND reply_at IS NULL AND sent_at < NOW() - ($1 || ' days')::interval RETURNING id`, [String(Number(s.b2b.followupDays || 5))]);
  return { klaargezet: r.length };
}

// ---------------------------------------------------------------- inbox: reacties, bounces en "stop"
export async function scanInbox({ days = 14, max = 150 } = {}) {
  const m = mailEnv("b2b");
  if (!m.user || !m.pass || env("MAIL_TRANSPORT") === "capture") return { skipped: true };
  const client = new ImapFlow({ host: m.imapHost, port: m.imapPort, secure: true, auth: { user: m.user, pass: m.pass }, logger: false, socketTimeout: 15000 });
  const leads = await q("SELECT id, email, company, message_id, followup_id, status FROM leads WHERE status IN ('verstuurd','opvolging_goedgekeurd','opgevolgd','interesse') AND email IS NOT NULL");
  const byEmail = new Map(leads.map((l) => [l.email.toLowerCase(), l]));
  const byMsg = new Map();
  for (const l of leads) { if (l.message_id) byMsg.set(l.message_id, l); if (l.followup_id) byMsg.set(l.followup_id, l); }
  let replies = 0, bounces = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ since: new Date(Date.now() - days * 86400000) }, { uid: true })) || [];
      for await (const msg of client.fetch(uids.slice(-max), { envelope: true, source: { maxLength: 60000 } }, { uid: true })) {
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase() || "";
        const src = msg.source?.toString("utf8") || "";
        if (/mailer-daemon|postmaster/i.test(from)) {
          const hit = [...byEmail.keys()].find((e) => src.toLowerCase().includes(e));
          if (hit) { await q("UPDATE leads SET status = 'fout', error = 'Mail kwam niet aan (bounce).', bounced_at = COALESCE(bounced_at, NOW()), updated_at = NOW() WHERE id = $1 AND status <> 'fout'", [byEmail.get(hit).id]); bounces++; }
          continue;
        }
        const lead = byMsg.get((msg.envelope?.inReplyTo || "").trim()) || byEmail.get(from);
        if (!lead) continue;
        const body = src.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/=\r?\n/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
        const stop = /\b(afmelden|uitschrijven|geen interesse|niet meer mailen|stop)\b/i.test(body.slice(0, 200));
        const upd = await one(`UPDATE leads SET status = $2, reply_at = $3, reply_snippet = $4, updated_at = NOW() WHERE id = $1 AND status NOT IN ('reactie','afspraak','klant','afgemeld') RETURNING id`,
          [lead.id, stop ? "afgemeld" : "reactie", msg.envelope?.date || new Date(), body]);
        if (/\b(spam|ongevraagd|klacht)\b/i.test(body.slice(0, 300))) await q("UPDATE leads SET klacht_at = COALESCE(klacht_at, NOW()) WHERE id = $1", [lead.id]);
        if (stop) await q("INSERT INTO suppressions (email, reason) VALUES ($1, 'reactie: stop') ON CONFLICT DO NOTHING", [lead.email.toLowerCase()]);
        if (upd && !stop) await notifyStaff(`Reactie van ${lead.company}`, [`${lead.company} reageerde op de mail:`, `"${body.slice(0, 280)}"`], `/hq/#b2b/lead/${lead.id}`).catch(() => {});
        if (upd) replies++;
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    try { client.close(); } catch {}
    return { error: e.authenticationFailed ? "Inloggen op de inbox lukt niet." : `Inbox niet bereikbaar (${e.code || e.message})` };
  }
  return { replies, bounces };
}

// ---------------------------------------------------------------- scout (Outscraper, Google Maps)
async function osc(path, params) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`https://api.app.outscraper.com${path}${qs.toString() ? "?" + qs : ""}`, { headers: { "X-API-KEY": env("OUTSCRAPER_API_KEY") }, signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.errorMessage) { const e = new Error(d.errorMessage || `status ${r.status}`); e.status = r.status; throw e; }
  return d;
}
// Werkdagen vanaf 7:00: per categorie een zoekopdracht in de volgende plaats.
export async function runScout({ force = false } = {}) {
  const s = await getSettings();
  const sc = s.b2b.scout || {};
  if (!scoutReady()) return { skipped: "geen OUTSCRAPER_API_KEY" };
  const st = await getState("scout_state", {});
  if (!sc.active && !force) return st.pending?.length ? collect(st) : { skipped: "scout staat uit" };
  const day = dayKey(), wd = new Date(day + "T12:00:00Z").getUTCDay();
  if (!force && (st.lastDay === day || !verzendDag(s, wd) || hourAms() < 7)) return collect(st);
  const cats = (sc.categories || []).filter(Boolean), places = (sc.places || []).filter(Boolean);
  if (!cats.length || !places.length) return { skipped: "geen categorieën of plaatsen" };
  st.pending = st.pending || [];
  const per = Math.max(5, Math.min(120, Math.ceil(Number(sc.perDay || 60) / cats.length) * 2));
  for (const cat of cats) {
    const i = (st.cursor?.[cat] || 0) % places.length;
    const d = await osc("/maps/search-v3", { query: `${cat}, ${places[i]}, Nederland`, organizationsPerQueryLimit: per, language: "nl", region: "NL", async: true, enrichment: "domains_service" });
    st.pending.push({ id: d.id, cat, place: places[i], at: new Date().toISOString() });
    st.history = [{ cat, place: places[i], at: new Date().toISOString(), status: "bezig" }, ...(st.history || [])].slice(0, 60);
    st.cursor = { ...(st.cursor || {}), [cat]: i + 1 };
  }
  st.lastDay = day; st.lastAt = new Date().toISOString();
  await saveSetting("scout_state", st);
  return { submitted: cats.length };
}
const GEEN_HORECA = /(snackbar|friettent|shoarma|kebab|pizzeria bezorg|fastfood|mcdonald|burger king|kfc|subway|domino|new york pizza|febo|starbucks)/i;
async function collect(st) {
  if (!st.pending?.length) return { idle: true };
  const still = []; let added = 0;
  const hist = (p, upd) => { const h = (st.history || []).find((x) => x.at === p.at && x.cat === p.cat && x.place === p.place); if (h) Object.assign(h, upd); };
  for (const p of st.pending) {
    let d; try { d = await osc(`/requests/${p.id}`); } catch { still.push(p); continue; }
    if (String(d.status).toLowerCase() !== "success") { if (Date.now() - Date.parse(p.at) < 6 * 3600000) still.push(p); else hist(p, { status: "mislukt" }); continue; }
    const rows = (Array.isArray(d.data) ? d.data : []).flat();
    let nieuw = 0;
    for (const r of rows) {
      const site = r.site || r.website || "", dom = domainOf(site);
      if (/permanently|closed/i.test(String(r.business_status || ""))) continue;
      if (GEEN_HORECA.test(String(r.name || "")) || GEEN_HORECA.test(String(r.type || ""))) continue;
      if (!dom || /facebook\.|instagram\.|linkedin\.|google\.|business\.site|thefork\.|tripadvisor\.|booking\.com|ubereats|thuisbezorgd/i.test(dom)) continue;
      // Mailadressen die Outscraper (Emails & Contacts) al vond; de research kiest daaruit als de site niets oplevert.
      const gevonden = [r.email_1, r.email_2, r.email_3, ...(Array.isArray(r.emails) ? r.emails : [])].map((e) => cleanEmail(typeof e === "object" ? e?.value : e)).filter((e) => EMAIL_RE.test(e)).slice(0, 5).join(",");
      const res = await one(`INSERT INTO leads (company, website, domain, city, category, phone, source, status, gevonden_emails) VALUES ($1,$2,$3,$4,$5,$6,'scout','kandidaat',$7) ON CONFLICT DO NOTHING RETURNING id`,
        [str(r.name, 200), normUrl(site), dom, str(r.city, 100), p.cat, str(r.phone, 40), gevonden]).catch(() => null);
      if (res) { added++; nieuw++; }
    }
    hist(p, { status: "klaar", gevonden: rows.length, nieuw, klaarOp: new Date().toISOString() });
  }
  st.pending = still;
  await saveSetting("scout_state", st);
  return { added };
}

// ---------------------------------------------------------------- research: mailadres en openingszin
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function fetchOnce(url, ms) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "nl-NL,nl;q=0.9,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 600000);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#64;|&commat;|&#x40;/gi, "@").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();
    return { html, text, url: r.url || url };
  } catch { return null; }
}
// Homepage met terugvallen: https/http en met/zonder www.
async function fetchText(url, budgetMs = 9000) {
  const leeg = { html: "", text: "", url };
  let u; try { u = new URL(url); } catch { return leeg; }
  const host = u.hostname.replace(/^www\./, "");
  const pogingen = [u.href, `https://www.${host}${u.pathname}`, `https://${host}${u.pathname}`, `http://www.${host}/`];
  const eind = Date.now() + budgetMs;
  for (const p of [...new Set(pogingen)]) {
    const rest = eind - Date.now(); if (rest < 1500) break;
    const r = await fetchOnce(p, Math.min(7000, rest)); if (r && r.text) return r;
  }
  return leeg;
}
// Cloudflare "email protection" (data-cfemail / /cdn-cgi/l/email-protection#…)
function cfDecode(hex) { try { const k = parseInt(hex.slice(0, 2), 16); let out = ""; for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k); return out; } catch { return ""; } }
function findEmails(html, text, dom) {
  const set = new Set();
  let bron = html + " " + text;
  try { bron += " " + decodeURIComponent(html.replace(/%(?![0-9a-f]{2})/gi, "%25")); } catch {}
  bron = bron.replace(/\\u0040/gi, "@").replace(/\s*[\[(]\s*(at|apenstaart)\s*[\])]\s*/gi, "@").replace(/\s*[\[(]\s*(dot|punt)\s*[\])]\s*/gi, ".");
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']|email-protection#([0-9a-f]+)/gi)) bron += " " + cfDecode(m[1] || m[2]);
  for (const m of bron.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) set.add(m[0].toLowerCase().replace(/^(mailto:|%20)/, "").replace(/\.$/, ""));
  return [...set].filter((e) => EMAIL_RE.test(e) && !/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(e) && !/sentry|wixpress|example|domain\.|email\.com|@2x|godaddy|yourdomain|jouwdomein|naam@|name@|test@/.test(e))
    .sort((a, b) => (b.endsWith("@" + dom) ? 1 : 0) - (a.endsWith("@" + dom) ? 1 : 0));
}
// Beste adres: algemeen op eigen domein > algemeen elders > persoonlijk op eigen domein > gmail e.d. > elk ander adres op de site.
function kiesEmail(emails, dom) {
  const eigen = (e) => dom && (e.endsWith("@" + dom) || e.endsWith("." + dom));
  return emails.find((e) => GENERIC.test(e) && eigen(e) && !FREEMAIL.test(e))
    || emails.find((e) => GENERIC.test(e) && !FREEMAIL.test(e))
    || emails.find((e) => eigen(e) && !FREEMAIL.test(e))
    || emails.find((e) => FREEMAIL.test(e))
    || emails[0] // keuze Maxim: elk adres dat op de site staat
    || "";
}
async function hasMx(domain) { try { return (await dns.resolveMx(domain)).length > 0; } catch (e) { return e.code === "ETIMEOUT"; } }

const LUMIQ = `Lumiq (lumiqstore.com) levert draadloze, oplaadbare tafellampen voor de horeca: met één tik vanaf de bar alle lampen aan via app of touchpaneel, tot 24 uur licht, IP44, 12 series. Toon: warm, kort, je/jullie, van ondernemer tot ondernemer. Nooit iets verzinnen.`;
export async function schrijfIntro(lead, text) {
  const s = await getSettings();
  if ((!aiReady() && env("AI_FAKE") !== "1") || s.b2b.ai?.research === false || String(text || "").length < 200) return { intro: "", note: "" };
  try {
    const out = await claude({
      system: LUMIQ + "\nJe schrijft de persoonlijke openingszin van een korte verkoopmail aan een horecazaak.",
      prompt: `Zaak: ${lead.company} (${lead.category || ""}, ${lead.city || ""}). Website: ${lead.website}
Tekst van hun site (ingekort):
"""${String(text).slice(0, 6000)}"""

De mail begint met: "Hi, Ik kwam {zaak} tegen en zag de sfeervolle foto's van jullie zaak." dan JOUW zin, dan: "Wat me opviel: jullie hebben nog geen sfeervolle tafellampen op tafel staan."
Regels: één korte zin, max. 16 woorden, over de zaak (jullie), spreek de lezer niet direct aan. Zeg iets warms en herkenbaars over de sfeer of het soort zaak (bijv. terras, aan het water, intiem diner, hotelbar), eventueel met de plaats.
Geen opsommingen, geen gerechten of merknamen, geen straatnamen, geen jaartallen, geen clichés ("mooi om te zien"), geen vraag, geen uitroepteken, niets verzinnen. Is er niets concreets, laat intro leeg.
Goed: "Een terras aan het water in Rotterdam, daar wil je 's avonds blijven zitten."
Goed: "Een hotelbar waar gasten na het diner nog even blijven hangen, daar draait alles om sfeer."
Geef ook een notitie (max. 20 woorden): wat voor zaak (restaurant/hotel/bar/beach club), groot of klein, terras ja/nee als dat blijkt.
Antwoord alleen met JSON: {"intro":"...","notitie":"..."}`,
    });
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    let intro = str(j.intro, 300).replace(/\s*!\s*$/, ".");
    if (/\b(u|uw)\b/i.test(intro)) intro = "";
    return { intro, note: str(j.notitie, 200) };
  } catch (e) { console.log("[b2b] ai", e.message); return { intro: "", note: "" }; }
}

export async function researchLead(lead) {
  if (!lead.website) {
    await q("UPDATE leads SET status = 'overgeslagen', reject_reason = 'geen website (bel ze eventueel)', researched_at = NOW(), updated_at = NOW() WHERE id = $1", [lead.id]);
    return { skipped: true };
  }
  const home = await fetchText(lead.website);
  // Contact-achtige pagina's (max. 4) en altijd /contact.
  const paginas = new Set();
  if (home.text) {
    for (const m of home.html.matchAll(/href=["']([^"'#]+)["']/gi)) {
      if (/contact|reserver|over-ons|overons|about|impressum|colofon|privacy|voorwaarden|groepen|events|zakelijk|team/i.test(m[1]) && !/\.(jpe?g|png|pdf|webp)$/i.test(m[1])) {
        try { const u = new URL(m[1], home.url); if (u.hostname.replace(/^www\./, "") === new URL(home.url).hostname.replace(/^www\./, "")) paginas.add(u.href.split("#")[0]); } catch {}
      }
    }
    try { paginas.add(new URL("/contact", home.url).href); } catch {}
  }
  let html = home.html, alleText = home.text;
  for (const r of await Promise.all([...paginas].slice(0, 4).map((p) => fetchOnce(p, 5000)))) if (r) { html += " " + r.html; alleText += " " + r.text; }
  const text = alleText.slice(0, 30000);
  const emails = [...new Set([...findEmails(html, alleText, lead.domain), ...String(lead.gevonden_emails || "").split(",").map((e) => cleanEmail(e)).filter((e) => EMAIL_RE.test(e))])];
  let reason = "";
  const email = kiesEmail(emails, lead.domain);
  if (!email) reason = home.text ? "geen mailadres op de site" : "website niet bereikbaar";
  if (!reason && !(await hasMx(email.split("@")[1]))) reason = "domein ontvangt geen mail";
  if (!reason && (await one("SELECT 1 FROM suppressions WHERE email = $1", [email]))) reason = "eerder afgemeld";
  if (!reason && (await one("SELECT 1 FROM leads WHERE lower(email) = $1 AND id <> $2", [email, lead.id]))) reason = "adres staat al bij een andere lead";
  if (reason) {
    await q("UPDATE leads SET status = 'overgeslagen', reject_reason = $2, researched_at = NOW(), updated_at = NOW() WHERE id = $1", [lead.id, reason]);
    return { reason };
  }
  const { intro, note } = await schrijfIntro(lead, text);
  const s = await getSettings();
  await q("UPDATE leads SET email = $2, status = $5, intro = $3, research_note = $4, researched_at = NOW(), reject_reason = '', updated_at = NOW() WHERE id = $1",
    [lead.id, email, intro, note, s.b2b.autoGoedkeuren ? "goedgekeurd" : "nieuw"]);
  return { email };
}
export async function runResearch({ max = 3, budgetMs = 8000 } = {}) {
  const started = Date.now();
  const todo = await q("SELECT * FROM leads WHERE status = 'kandidaat' ORDER BY created_at LIMIT $1", [max]);
  let done = 0;
  for (const l of todo) { if (Date.now() - started > budgetMs) break; await researchLead(l).catch((e) => console.log("[b2b] research", e.message)); done++; }
  return { done };
}

// ---------------------------------------------------------------- beheer vanuit HQ
export async function addLead(b, userId) {
  const email = b.email ? cleanEmail(b.email) : null;
  if (email && !EMAIL_RE.test(email)) fail(400, `Ongeldig e-mailadres: ${b.email}`);
  const website = normUrl(b.website || "");
  const company = str(b.company, 200) || domainOf(website) || (email ? email.split("@")[1] : "");
  if (!company) fail(400, "Vul minimaal een naam, website of e-mailadres in.");
  if (email && (await one("SELECT 1 FROM suppressions WHERE email = $1", [email]))) fail(400, `${email} heeft zich eerder afgemeld en wordt niet opnieuw toegevoegd.`);
  const status = email ? "nieuw" : website ? "kandidaat" : "nieuw";
  const row = await one(`INSERT INTO leads (company, email, website, domain, city, category, phone, source, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
    [company, email, website, website ? domainOf(website) : "", str(b.city, 100), str(b.category, 80), str(b.phone, 40), b.source || "handmatig", status, str(b.notes, 1000)]);
  if (!row) return { duplicate: true };
  await audit(userId, "lead.toegevoegd", { id: row.id });
  return { lead: row };
}
export function parseCsv(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
  const split = (l) => { const out = []; let cur = "", inQ = false; for (const ch of l) { if (ch === '"') inQ = !inQ; else if (ch === sep && !inQ) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const idx = (names) => head.findIndex((h) => names.includes(h));
  const col = { company: idx(["bedrijf", "bedrijfsnaam", "zaak", "company", "naam", "name"]), email: idx(["email", "e-mail", "mail"]), website: idx(["website", "site", "url"]), city: idx(["plaats", "stad", "city"]), category: idx(["categorie", "branche", "soort", "category"]), phone: idx(["telefoon", "phone", "tel"]) };
  if (col.company < 0 && col.email < 0 && col.website < 0) fail(400, "Ik herken de kolommen niet. Gebruik een kopregel met bijvoorbeeld: zaak;email;website;plaats;soort");
  return lines.slice(1, 2001).map(split).map((r) => Object.fromEntries(Object.entries(col).filter(([, i]) => i >= 0).map(([k, i]) => [k, r[i] || ""])));
}
export async function sendTestMail(leadId, kind, aan) {
  if (!mailReady("b2b")) fail(503, "De mail is nog niet ingesteld.");
  if (!EMAIL_RE.test(String(aan || ""))) fail(400, "Geen geldig adres om de testmail naar te sturen.");
  const s = await getSettings();
  const lead = leadId ? await one("SELECT * FROM leads WHERE id = $1", [leadId]) : { id: 0, company: "Restaurant De Proef", city: "Rotterdam", intro: "Een terras aan het water in Rotterdam, daar wil je 's avonds blijven zitten." };
  if (!lead) fail(404, "Lead niet gevonden.");
  const mail = compose(lead, kind === "opvolging" ? "opvolging" : "eerste", s);
  const body = mail.body.split(unsubUrl(lead.id)).join(`${publicBase()}/api/b2b/afmelden?test=1`);
  const res = await sendMail({ to: aan, subject: `[TEST] ${mail.subject}`, text: body, html: textToHtml(body, null, s), kind: "test-b2b", ref: `test:${leadId || 0}`, fromName: fromName(s), account: "b2b" });
  if (!res?.ok) fail(502, res?.error || "Versturen lukte niet.");
  return { ok: true, aan };
}
export const _research = { findEmails, kiesEmail, cfDecode };
