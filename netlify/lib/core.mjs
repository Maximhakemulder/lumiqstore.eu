// Gedeelde basis: omgeving, database, instellingen, tijd, geld en HTTP-hulpjes. (Opzet zoals Sitemaker HQ.)
import crypto from "node:crypto";
import { getDatabase } from "@netlify/database";
import pg from "pg";

// Datums (DATE) als tekst "YYYY-MM-DD" teruggeven, zonder tijdzone-verschuiving. NUMERIC als getal.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number(v));

export const env = (k, d = "") => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? d);

// ---------------------------------------------------------------- database
let _db = null;
function db() {
  if (!_db) {
    const cs = env("LQ_DB_URL");
    _db = cs ? getDatabase({ connectionString: cs }) : getDatabase();
  }
  return _db;
}
export async function q(text, params = []) { return (await db().pool.query(text, params)).rows; }
export async function one(text, params = []) { return (await q(text, params))[0] || null; }
export async function tx(fn) {
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn({
      q: async (t, p = []) => (await client.query(t, p)).rows,
      one: async (t, p = []) => (await client.query(t, p)).rows[0] || null,
    });
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally { client.release(); }
}
export async function closeDb() { if (_db) { await _db.pool.end().catch(() => {}); _db = null; } }

// Vergrendeling voor geplande taken (zodat twee rondes niet tegelijk mailen).
export async function withLock(name, fn, ttlMs = 30000) {
  const got = await one(`INSERT INTO locks (name, until) VALUES ($1, NOW() + ($2 || ' milliseconds')::interval)
     ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until WHERE locks.until < NOW() RETURNING name`, [name, String(ttlMs)]);
  if (!got) return { locked: true };
  try { return await fn(); } finally { await q("DELETE FROM locks WHERE name = $1", [name]).catch(() => {}); }
}

// ---------------------------------------------------------------- instellingen
export const HORECA = ["restaurant", "hotel", "bar", "café", "cocktailbar", "wijnbar", "grand café", "brasserie", "steakhouse", "beach club", "strandpaviljoen", "lunchroom", "bistro", "restaurant met terras"];
export const PLAATSEN = ["Amsterdam", "Rotterdam", "Den Haag", "Utrecht", "Eindhoven", "Breda", "Haarlem", "Maastricht", "Groningen", "Arnhem", "Nijmegen", "Den Bosch", "Tilburg", "Zwolle", "Leiden", "Delft", "Scheveningen", "Zandvoort", "Noordwijk", "Bergen op Zoom"];
export const DEFAULT_SETTINGS = {
  company: {
    name: "Lumiq", legalName: "Gosmart B.V.", address: "", postcode: "", city: "", country: "Nederland",
    kvk: "86560875", vat: "NL864006640B01", iban: "", bic: "",
    email: "info@lumiqstore.eu", phone: "+31 6 54914510", website: "https://lumiqstore.com",
  },
  finance: { vatRate: 21, paymentTermDays: 14, invoicePrefix: "LQ", reminderDays: 7, autoReminders: true },
  inkoop: { leverancier: "Leverancier (China)", productieDagen: 21, verzendDagen: 7, moq: 50 },
  notify: { email: "" },
  catalogus: { url: "/brochure/lumiq-catalogus.pdf", melding: true },
  b2b: {
    senderName: "Armand",
    senderRole: "Sales & partnerships",
    senderEmail: "armand@lumiqstore.com",
    handtekening: "/assets/mail/handtekening-armand.png", // afbeelding onder elke B2B-mail; leeg = alleen tekst
    dailyMax: 20,        // rustig opbouwen: week 1–2 20, week 3–4 35, daarna 50
    perUur: 0,           // 0 = daglimiet gelijk verdeeld over de verzenduren
    sendHours: [8, 17],
    followupDays: 5,
    autoGoedkeuren: false, // false = Maxim keurt elke lead goed voordat de eerste mail gaat
    meten: { opens: true, kliks: true },
    ai: { research: true },
    scout: { active: false, perDay: 60, categories: ["restaurant", "hotel", "cocktailbar", "wijnbar", "grand café", "beach club", "brasserie"], places: ["Rotterdam", "Amsterdam", "Den Haag", "Utrecht", "Breda", "Eindhoven"] },
    templates: {
      eerste: {
        subject: "Sfeervolle tafellampen voor {bedrijf}",
        body: "Hallo,\n\nIk kwam {bedrijf} tegen en zag de sfeervolle foto's van jullie zaak. {intro}Wat me opviel: jullie hebben nog geen sfeervolle tafellampen op tafel staan.\n\nHieronder vindt u onze brochure met al onze draadloze tafellampen. Neem deze gerust even door, ik hoor graag als er vragen zijn.\n{catalogus}\n\nEen hele fijne dag toegewenst!\n\nMet vriendelijke groet,\n{afzender}",
      },
      opvolging: {
        subject: "Re: Sfeervolle tafellampen voor {bedrijf}",
        body: "Hallo,\n\nVorige week stuurde ik u onze brochure met draadloze tafellampen. Heeft u er al even naar kunnen kijken?\n\nVoor het gemak hier nog een keer de link:\n{catalogus}\n\nZullen we anders even kort bellen? U kunt mij bereiken op {telefoon}. Een demo bij u in de zaak kan natuurlijk ook.\n\nEen hele fijne dag toegewenst!\n\nMet vriendelijke groet,\n{afzender}",
      },
    },
  },
};
function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  return out;
}
export async function getSettings() {
  const rows = await q("SELECT key, value FROM settings");
  return merge(DEFAULT_SETTINGS, Object.fromEntries(rows.map((r) => [r.key, r.value])));
}
export async function saveSetting(key, value) {
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
}
export async function getState(key, d = null) { return (await one("SELECT value FROM settings WHERE key = $1", [key]))?.value ?? d; }

// ---------------------------------------------------------------- tijd en geld
export const TZ = "Europe/Amsterdam";
export const dayKey = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: TZ });
export const hourAms = (d = new Date()) => Number(d.toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }));
export const euro = (c) => (Number(c) < 0 ? "-€ " : "€ ") + (Math.abs(Number(c || 0)) / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
export const datumNl = (d) => (d ? new Date(String(d).length === 10 ? d + "T12:00:00Z" : d).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric", timeZone: TZ }) : "");
export const cents = (v) => {
  if (typeof v === "number") return Math.round(v);
  const s = String(v ?? "").replace(/[€\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

// ---------------------------------------------------------------- tekst
export const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[a-z]{2,}$/i;
export const cleanEmail = (e) => String(e || "").trim().toLowerCase();
export const str = (v, max = 500) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
export const int = (v, d = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");
export const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function domainOf(u) {
  try { return new URL(/^https?:/i.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
export function normUrl(u) {
  const s = str(u, 300); if (!s) return "";
  try { const x = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); return /^https?:$/.test(x.protocol) ? x.href.replace(/\/$/, "") : ""; } catch { return ""; }
}

// ---------------------------------------------------------------- HTTP
export const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
export class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

// Publieke basis-URL voor links in mails: de productie-URL als die bekend is.
export function publicBase(req) {
  const fixed = env("PUBLIC_BASE_URL") || (env("CONTEXT") === "production" ? env("URL") : "");
  if (fixed) return fixed.replace(/\/$/, "");
  if (req) { const u = new URL(req.url); return `${u.protocol}//${u.host}`; }
  return (env("PUBLIC_BASE_URL") || env("URL") || "https://lumiqstore.com").replace(/\/$/, "");
}
export const hqUrl = () => publicBase() + "/hq/";

export async function audit(userId, action, detail = {}) {
  await q("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3::jsonb)", [userId || null, action, JSON.stringify(detail)]).catch(() => {});
}
