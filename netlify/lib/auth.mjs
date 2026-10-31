// Inloggen op Lumiq HQ met een eenmalige code per e-mail (geen wachtwoorden). Zoals Sitemaker HQ.
// Alleen adressen in HQ_ALLEEN (of ADMIN_EMAILS) komen erin; de eerste is beheerder.
import crypto from "node:crypto";
import { env, q, one, tx, cleanEmail, EMAIL_RE, sha256, randomToken, fail } from "./core.mjs";
import { sendMail, brandHtml, mailReady } from "./mail.mjs";

const CODE_MINUTES = 10, MAX_ATTEMPTS = 5, SESSION_DAYS = 14;
export const COOKIE = "lq_sess";
const pepper = () => env("AUTH_SECRET", "lumiq-local-dev");
const hashCode = (email, code) => crypto.createHmac("sha256", pepper()).update(`${email}:${code}`).digest("hex");
export const ipOf = (req, context) => context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";

const lijst = (k) => env(k).split(",").map(cleanEmail).filter(Boolean);
export const toegang = () => [...new Set([...lijst("HQ_ALLEEN"), ...lijst("ADMIN_EMAILS")])];

async function findUser(email) {
  if (!toegang().includes(email)) return null;
  const admin = lijst("ADMIN_EMAILS").includes(email) || toegang()[0] === email;
  return one(`INSERT INTO users (email, role) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET role = CASE WHEN $2 = 'admin' THEN 'admin' ELSE users.role END RETURNING *`,
    [email, admin ? "admin" : "medewerker"]);
}

export async function requestCode(rawEmail, ip) {
  const email = cleanEmail(rawEmail);
  if (!EMAIL_RE.test(email)) fail(400, "Vul een geldig e-mailadres in.");
  const [{ n: perEmail }] = await q("SELECT COUNT(*)::int AS n FROM login_codes WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'", [email]);
  const [{ n: perIp }] = await q("SELECT COUNT(*)::int AS n FROM login_codes WHERE ip = $1 AND ip <> '' AND created_at > NOW() - INTERVAL '1 hour'", [ip]);
  if (perEmail >= 5 || perIp >= 20) fail(429, "Je hebt te vaak een code aangevraagd. Probeer het over een uur opnieuw.");
  const user = await findUser(email);
  const allowed = !!(user && user.active);
  const vast = vasteCode();
  const code = vast || String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await q("INSERT INTO login_codes (email, code_hash, ip, expires_at, used) VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, $5)",
    [email, hashCode(email, code), ip, String(CODE_MINUTES), !allowed]);
  if (!allowed) return { sent: false, vast: !!vast }; // geen verschil zichtbaar voor onbekende adressen
  if (vast) return { sent: true, vast: true };
  if (!mailReady()) fail(503, "Inloggen per mail is nog niet ingesteld (MAIL_USER/MAIL_PASSWORD in Netlify).");
  const res = await sendMail({
    to: email, kind: "inlogcode", subject: `Je inlogcode: ${code}`,
    text: `Je inlogcode voor Lumiq HQ is: ${code}\n\nDe code is ${CODE_MINUTES} minuten geldig.`,
    html: brandHtml({ title: "Je inlogcode", intro: ["Gebruik deze code om in te loggen op Lumiq HQ:",
      `<span style="display:inline-block;font-size:30px;letter-spacing:8px;font-weight:bold;color:#1a1612;background:#f3eee6;border-radius:10px;padding:12px 18px">${code}</span>`,
      `De code is ${CODE_MINUTES} minuten geldig.`], after: ["Heb je niet geprobeerd in te loggen? Dan kun je deze mail negeren."] }),
  });
  if (!res.ok) fail(502, "We konden de code niet versturen. Probeer het zo opnieuw.");
  return { sent: true };
}

// Vaste code (HQ_CODE, precies 6 cijfers, in Netlify): inloggen met alleen die code, als de eerste beheerder.
// Max. 10 foute pogingen per uur per IP. Zonder HQ_CODE: weer de code per mail.
export const vasteCode = () => (/^\d{6}$/.test(env("HQ_CODE")) ? env("HQ_CODE") : "");
const VAST = "__vaste-code__";
export async function verifyVast(rawCode, ip) {
  const vast = vasteCode();
  if (!vast) fail(400, "Inloggen met een vaste code staat uit.");
  const code = String(rawCode || "").replace(/\D/g, "");
  const [{ n }] = await q("SELECT COUNT(*)::int AS n FROM login_codes WHERE email = $1 AND ip = $2 AND created_at > NOW() - INTERVAL '1 hour'", [VAST, ip || "?"]);
  if (n >= 10) fail(429, "Te veel foute pogingen. Probeer het over een uur opnieuw.");
  if (code.length !== 6 || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(vast))) {
    await q("INSERT INTO login_codes (email, code_hash, ip, expires_at, used) VALUES ($1, '', $2, NOW(), TRUE)", [VAST, ip || "?"]);
    fail(400, "Deze code klopt niet.");
  }
  const user = await findUser(toegang()[0] || "");
  if (!user) fail(403, "Zet ADMIN_EMAILS in Netlify.");
  const token = randomToken(32);
  await q("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' days')::interval)", [sha256(token), user.id, String(SESSION_DAYS)]);
  await q("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
  return { user, cookie: sessionCookie(token, SESSION_DAYS * 86400) };
}

export async function verifyCode(rawEmail, rawCode) {
  const email = cleanEmail(rawEmail);
  const code = String(rawCode || "").replace(/\D/g, "");
  if (!EMAIL_RE.test(email) || code.length !== 6) fail(400, "Vul de 6 cijfers uit de mail in.");
  return tx(async (t) => {
    const row = await t.one(`SELECT * FROM login_codes WHERE email = $1 AND used = FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [email]);
    if (!row) fail(400, "Deze code is verlopen of al gebruikt. Vraag een nieuwe code aan.");
    if (row.attempts >= MAX_ATTEMPTS) fail(429, "Te veel pogingen. Vraag een nieuwe code aan.");
    if (!crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(email, code)))) {
      await t.q("UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
      const left = MAX_ATTEMPTS - row.attempts - 1;
      fail(400, left > 0 ? `Deze code klopt niet. Nog ${left} ${left === 1 ? "poging" : "pogingen"}.` : "Te veel pogingen. Vraag een nieuwe code aan.");
    }
    await t.q("UPDATE login_codes SET used = TRUE WHERE email = $1 AND used = FALSE", [email]);
    const user = await t.one("SELECT * FROM users WHERE email = $1 AND active = TRUE", [email]);
    if (!user || !toegang().includes(email)) fail(403, "Dit account heeft geen toegang.");
    const token = randomToken(32);
    await t.q("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' days')::interval)", [sha256(token), user.id, String(SESSION_DAYS)]);
    await t.q("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
    await t.q("DELETE FROM sessions WHERE expires_at < NOW()");
    return { user, cookie: sessionCookie(token, SESSION_DAYS * 86400) };
  });
}

const secure = () => (env("LQ_INSECURE_COOKIE") === "1" ? "" : "; Secure");
export const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure()}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure()}`;
function tokenFrom(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  return m ? m[1] : null;
}
export async function currentUser(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const u = await one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active`, [sha256(token)]);
  return u && toegang().includes(u.email) ? u : null;
}
export async function logout(req) {
  const token = tokenFrom(req);
  if (token) await q("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  return clearCookie();
}
export function requireStaff(u) { if (!u) fail(401, "Je bent niet (meer) ingelogd."); return u; }
export function requireAdmin(u) { requireStaff(u); if (u.role !== "admin") fail(403, "Alleen een beheerder kan dit."); return u; }
