// Losse mailcampagnes naar leads die al gemaild zijn (keuze Maxim 17-11-2026: "Klant uitgelicht: Van der Valk").
// Los van de gewone B2B-mails: eigen teller (mail_log kind 'campagne') en eigen daglimiet, wel binnen de B2B-verzendtijden.
// Starten gebeurt alleen met een klik in HQ; testmails gaan naar een adres naar keuze.
import fs from "node:fs/promises";
import path from "node:path";
import { env, q, one, getSettings, str, cleanEmail, dayKey, hourAms, publicBase, fail, audit } from "./core.mjs";
import { sendMail, mailReady } from "./mail.mjs";
import { unsubUrl, trackLink, trackPixel, verzendDag } from "./b2b.mjs";

export const CAMPAGNES = {
  "vdv-akersloot": {
    naam: "Klant uitgelicht: Van der Valk Akersloot",
    onderwerp: "Dit is Van der Valk Exclusief in Akersloot",
    bestand: "public/mail/klant-uitgelicht-vdv.html",
    tekst: `Klant uitgelicht: Van der Valk Exclusief Akersloot

Van der Valk Exclusief Akersloot koos voor Lumiq. Op elke tafel, in de nissen en aan de lange tafel brandt nu een draadloze lamp. Ze gaan allemaal tegelijk aan, met één tik vanaf de bar.

Gasten zien sfeer. Het team ziet geen snoeren, geen kaarsjes en geen gedoe.

Benieuwd wat er bij jou kan? Ontvang direct de catalogus. Binnen één werkdag denken we met je mee:
{link}

Liever even bellen? +31 6 54914510

Warme groet,
Armand
Lumiq · draadloze tafellampen voor de horeca`,
  },
};
const AFMELD_PLEK = "mailto:armand@lumiqstore.com?subject=Afmelden";
const LINK_RE = /https:\/\/lumiqstore\.com\/benieuwd\/\?utm_source=mail-vdv/g;
const RUST_DAGEN = 2; // wie de laatste 2 dagen een B2B-mail kreeg, schuift op

async function laadHtml(c) {
  for (const p of [path.join(process.cwd(), c.bestand), path.join(process.cwd(), "..", c.bestand)]) {
    try { return await fs.readFile(p, "utf8"); } catch {}
  }
  const r = await fetch(`${publicBase()}/${c.bestand.replace(/^public\//, "")}`).catch(() => null);
  if (r?.ok) return r.text();
  fail(500, "De mail-HTML kon niet geladen worden.");
}

// Wie krijgt hem: iedereen die minstens één B2B-mail kreeg, behalve afgemeld, bounce/fout en klanten. Eén keer per mailadres.
const ONTVANGERS_SQL = `
  SELECT DISTINCT ON (lower(l.email)) l.id, l.email FROM leads l
  WHERE l.sent_at IS NOT NULL AND l.email IS NOT NULL AND l.email <> ''
    AND l.status NOT IN ('afgemeld','klant','fout') AND l.bounced_at IS NULL AND l.unsub_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = lower(l.email))
  ORDER BY lower(l.email), l.id`;

export async function kandidaten() { return q(ONTVANGERS_SQL); }

function persoonlijk(html, leadId) {
  let h = html.split(AFMELD_PLEK).join(leadId ? unsubUrl(leadId) : `${publicBase()}/api/b2b/afmelden?test=1`);
  if (leadId) {
    h = h.replace(LINK_RE, (u) => trackLink(leadId, "campagne", u));
    h = h.replace("</body>", `<img src="${trackPixel(leadId, "campagne")}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">\n</body>`);
  }
  return h;
}
function tekstVoor(c, leadId) {
  const link = "https://lumiqstore.com/benieuwd/?utm_source=mail-vdv";
  return `${c.tekst.replace("{link}", link)}\n\n--\nGeen berichten meer van ons? Afmelden: ${leadId ? unsubUrl(leadId) : `${publicBase()}/api/b2b/afmelden?test=1`}`;
}

export async function overzicht(sleutel = "vdv-akersloot") {
  const c = CAMPAGNES[sleutel];
  const camp = await one("SELECT id, sleutel, naam, onderwerp, status, per_dag, gestart_door, created_at, klaar_at FROM campagnes WHERE sleutel = $1 ORDER BY id DESC LIMIT 1", [sleutel]);
  let tellingen = null, vandaag = 0;
  if (camp) {
    const rows = await q("SELECT status, COUNT(*)::int AS n FROM campagne_ontvangers WHERE campagne_id = $1 GROUP BY status", [camp.id]);
    tellingen = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    vandaag = (await one(`SELECT COUNT(*)::int AS n FROM mail_log WHERE kind = 'campagne' AND ok AND ref LIKE $1 AND created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')`, [`campagne:${camp.id}:%`])).n;
  }
  const kliks = camp ? (await one("SELECT COUNT(DISTINCT lead_id)::int AS n FROM mail_events WHERE mail = 'campagne' AND soort <> 'open' AND created_at >= $1", [camp.created_at])).n : 0;
  return { sleutel, naam: c.naam, onderwerp: c.onderwerp, voorbeeld: "/" + c.bestand.replace(/^public\//, ""), kandidaten: camp ? null : (await kandidaten()).length, campagne: camp, tellingen, vandaag, kliks, mail: mailReady("b2b") };
}

export async function testMail(sleutel, aan) {
  const c = CAMPAGNES[sleutel] || fail(404, "Onbekende campagne.");
  const to = cleanEmail(aan); if (!to) fail(400, "Vul een geldig mailadres in.");
  const html = await laadHtml(c);
  const r = await sendMail({ to, subject: `[TEST] ${c.onderwerp}`, text: tekstVoor(c, null), html: persoonlijk(html, null), kind: "campagne-test", ref: `campagne-test:${sleutel}`, fromName: "Armand | Lumiq", account: "b2b" });
  if (!r.ok) fail(502, r.error || "Versturen lukte niet.");
  return { ok: true, aan: to };
}

export async function start(sleutel, { perDag = 120, bevestig, door = "" } = {}) {
  const c = CAMPAGNES[sleutel] || fail(404, "Onbekende campagne.");
  const loopt = await one("SELECT id FROM campagnes WHERE sleutel = $1 AND status IN ('actief','gepauzeerd')", [sleutel]);
  if (loopt) fail(409, "Deze campagne loopt al.");
  const lijst = await kandidaten();
  if (!lijst.length) fail(400, "Er zijn geen leads om te mailen.");
  if (Number(bevestig) !== lijst.length) fail(409, `Het aantal ontvangers is veranderd (${lijst.length}). Ververs de pagina en bevestig opnieuw.`);
  const html = await laadHtml(c);
  const pd = Math.max(1, Math.min(500, Number(perDag) || 120));
  const camp = await one("INSERT INTO campagnes (sleutel, naam, onderwerp, html, tekst, per_dag, gestart_door) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [sleutel, c.naam, c.onderwerp, html, c.tekst, pd, str(door, 120)]);
  for (let i = 0; i < lijst.length; i += 200) {
    const deel = lijst.slice(i, i + 200);
    await q(`INSERT INTO campagne_ontvangers (campagne_id, lead_id, email) SELECT $1, x.id, x.email FROM unnest($2::int[], $3::text[]) AS x(id, email) ON CONFLICT DO NOTHING`, [camp.id, deel.map((r) => r.id), deel.map((r) => r.email)]);
  }
  await audit(null, "campagne-start", { campagne: c.naam, ontvangers: lijst.length, perDag: pd, door: str(door, 120) });
  return overzicht(sleutel);
}

export async function zetStatus(sleutel, status) {
  if (!["actief", "gepauzeerd", "gestopt"].includes(status)) fail(400, "Ongeldige status.");
  const camp = await one("SELECT id FROM campagnes WHERE sleutel = $1 ORDER BY id DESC LIMIT 1", [sleutel]) || fail(404, "Geen campagne gevonden.");
  await q("UPDATE campagnes SET status = $2, klaar_at = CASE WHEN $2 = 'gestopt' THEN NOW() ELSE klaar_at END WHERE id = $1 AND status <> 'klaar'", [camp.id, status]);
  return overzicht(sleutel);
}

// ---------------------------------------------------------------- versturen (vanuit tick)
export async function sendCampagnes({ budgetMs = 6000 } = {}) {
  if (!mailReady("b2b")) return { skipped: "mail" };
  const camp = await one("SELECT * FROM campagnes WHERE status = 'actief' ORDER BY id LIMIT 1");
  if (!camp) return { skipped: "geen" };
  const s = await getSettings();
  const now = new Date();
  const wd = new Date(dayKey(now) + "T12:00:00Z").getUTCDay();
  const [van, tot] = s.b2b.sendHours || [8, 17];
  if (env("B2B_ANY_TIME") !== "1" && (!verzendDag(s, wd) || hourAms(now) < van || hourAms(now) >= tot)) return { skipped: "buiten verzendtijd" };
  const vandaag = (await one(`SELECT COUNT(*)::int AS n FROM mail_log WHERE kind = 'campagne' AND ok AND created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')`)).n;
  let room = Math.max(0, camp.per_dag - vandaag);
  if (!room) return { skipped: "daglimiet" };
  const perUur = Math.max(1, Math.ceil(camp.per_dag / Math.max(1, tot - van)));
  const ditUur = (await one(`SELECT COUNT(*)::int AS n FROM mail_log WHERE kind = 'campagne' AND ok AND created_at >= (date_trunc('hour', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')`)).n;
  room = Math.min(room, Math.max(0, perUur - ditUur), Math.max(1, Math.ceil(perUur / 12)));
  if (room <= 0) return { skipped: "uurlimiet" };
  // Wie de laatste dagen al een B2B-mail kreeg, komt later aan de beurt (niet twee mails kort na elkaar).
  const todo = await q(`SELECT o.*, l.status AS lead_status, l.unsub_at FROM campagne_ontvangers o JOIN leads l ON l.id = o.lead_id
    WHERE o.campagne_id = $1 AND o.status = 'wachtend'
      AND GREATEST(COALESCE(l.sent_at, 'epoch'), COALESCE(l.followup_at, 'epoch')) < NOW() - ($3 || ' days')::interval
    ORDER BY o.id LIMIT $2`, [camp.id, room, String(RUST_DAGEN)]);
  if (!todo.length) {
    const rest = (await one("SELECT COUNT(*)::int AS n FROM campagne_ontvangers WHERE campagne_id = $1 AND status = 'wachtend'", [camp.id])).n;
    if (!rest) await q("UPDATE campagnes SET status = 'klaar', klaar_at = NOW() WHERE id = $1", [camp.id]);
    return { sent: 0, wacht: rest };
  }
  const started = Date.now();
  let sent = 0, failed = 0;
  for (const o of todo) {
    if (Date.now() - started > budgetMs) break;
    const geblokt = o.unsub_at || ["afgemeld", "klant", "fout"].includes(o.lead_status) || await one("SELECT 1 FROM suppressions WHERE email = $1", [o.email.toLowerCase()]);
    if (geblokt) { await q("UPDATE campagne_ontvangers SET status = 'overgeslagen', error = 'afgemeld of geblokkeerd' WHERE id = $1", [o.id]); continue; }
    const res = await sendMail({
      to: o.email, subject: camp.onderwerp, text: tekstVoor({ tekst: camp.tekst || "" }, o.lead_id), html: persoonlijk(camp.html, o.lead_id),
      kind: "campagne", ref: `campagne:${camp.id}:lead:${o.lead_id}`, fromName: "Armand | Lumiq", account: "b2b",
      headers: { "List-Unsubscribe": `<${unsubUrl(o.lead_id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    if (res.ok) { sent++; await q("UPDATE campagne_ontvangers SET status = 'verstuurd', sent_at = NOW(), error = '' WHERE id = $1", [o.id]); }
    else {
      failed++;
      if (res.code === "EAUTH" || [421, 450, 451, 452].includes(res.responseCode)) { await q("UPDATE campagne_ontvangers SET error = $2 WHERE id = $1", [o.id, str(res.error, 300)]); break; }
      await q("UPDATE campagne_ontvangers SET status = 'fout', error = $2 WHERE id = $1", [o.id, str(res.error, 300)]);
    }
    await new Promise((r) => setTimeout(r, env("MAIL_TRANSPORT") === "capture" ? 0 : 1500 + Math.random() * 1500));
  }
  return { sent, failed };
}
