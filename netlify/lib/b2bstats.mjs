// B2B-overzicht voor HQ: waar de scout zoekt, wat er vandaag verstuurd wordt en wat het oplevert (mailprestaties).
import { q, one, getSettings, getState, env, dayKey, hourAms } from "./core.mjs";
import { mailReady } from "./mail.mjs";
import { scoutReady, perUurVan } from "./b2b.mjs";

const T0 = "(date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')";
const VERSTUURD = "('verstuurd','opvolging_goedgekeurd','opgevolgd','interesse','reactie','afspraak','klant','afgemeld')";

// Prestaties van mails verstuurd tussen vanaf en tot (per mail: eerste of opvolging). Percentages t.o.v. afgeleverd.
async function mailStats(vanaf, tot = null) {
  const r = await one(`WITH m AS (
      SELECT DISTINCT ON (ref, kind) substring(ref from 6)::int AS lead_id, replace(kind, 'b2b-', '') AS mail, ok, created_at
      FROM mail_log WHERE kind LIKE 'b2b-%' AND ref LIKE 'lead:%' AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY ref, kind, created_at DESC)
    SELECT
      COUNT(*) FILTER (WHERE m.ok)::int AS verstuurd,
      COUNT(*) FILTER (WHERE m.ok AND l.bounced_at >= m.created_at)::int AS bounces,
      COUNT(*) FILTER (WHERE m.ok AND EXISTS (SELECT 1 FROM mail_events e WHERE e.lead_id = m.lead_id AND e.mail = m.mail AND e.soort = 'open'))::int AS geopend,
      COUNT(*) FILTER (WHERE m.ok AND EXISTS (SELECT 1 FROM mail_events e WHERE e.lead_id = m.lead_id AND e.mail = m.mail AND e.soort IN ('klik','catalogus')))::int AS geklikt,
      COUNT(*) FILTER (WHERE m.ok AND EXISTS (SELECT 1 FROM mail_events e WHERE e.lead_id = m.lead_id AND e.mail = m.mail AND e.soort = 'catalogus'))::int AS catalogus,
      COUNT(*) FILTER (WHERE m.ok AND l.reply_at >= m.created_at)::int AS reacties,
      COUNT(*) FILTER (WHERE m.ok AND l.unsub_at >= m.created_at)::int AS afmeldingen,
      COUNT(*) FILTER (WHERE m.ok AND l.klacht_at >= m.created_at)::int AS klachten,
      COUNT(*) FILTER (WHERE m.ok AND m.mail = 'eerste')::int AS eerste,
      COUNT(*) FILTER (WHERE m.ok AND m.mail = 'opvolging')::int AS opvolging
    FROM m JOIN leads l ON l.id = m.lead_id`, [vanaf, tot]);
  const afgeleverd = Math.max(0, r.verstuurd - r.bounces);
  const p = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return { ...r, afgeleverd, pct: { afgeleverd: p(afgeleverd, r.verstuurd), bounce: p(r.bounces, r.verstuurd), geopend: p(r.geopend, afgeleverd), geklikt: p(r.geklikt, afgeleverd), catalogus: p(r.catalogus, afgeleverd), reacties: p(r.reacties, afgeleverd), afmeldingen: p(r.afmeldingen, afgeleverd), klachten: p(r.klachten, afgeleverd) } };
}
export async function mailPrestaties() {
  const T = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const { t: vandaag, g: gisteren } = await one(`SELECT ${T0} AS t, ${T0} - INTERVAL '1 day' AS g`);
  const [a, g, b, c, d] = await Promise.all([mailStats(vandaag), mailStats(gisteren, vandaag), mailStats(T(7)), mailStats(T(30)), mailStats(null)]);
  const s = d.verstuurd >= 20 ? c : d;
  const waarschuwingen = [];
  if (s.verstuurd >= 20 && s.pct.bounce > 3) waarschuwingen.push(`Bounce ${s.pct.bounce}% (boven 3%): controleer de mailadressen en verlaag de daglimiet.`);
  if (s.verstuurd >= 20 && s.pct.klachten > 0.3) waarschuwingen.push(`Klachten ${s.pct.klachten}%: pas de tekst aan en verlaag de daglimiet.`);
  if (s.verstuurd >= 20 && s.pct.afmeldingen > 2) waarschuwingen.push(`Afmeldingen ${s.pct.afmeldingen}%: de mail past mogelijk niet bij deze soort zaken.`);
  return { vandaag: a, gisteren: g, d7: b, d30: c, alles: d, waarschuwingen };
}

export async function b2bDashboard() {
  const s = await getSettings();
  const sc = s.b2b.scout || {};
  const st = await getState("scout_state", {});
  const inbox = await getState("inbox_scan", null);
  const [tot, vandaag, perCat, perPlaats, dagen, wachtrij, opvolging] = await Promise.all([
    one(`SELECT COUNT(*)::int AS leads,
        COUNT(*) FILTER (WHERE email IS NOT NULL)::int AS met_mail,
        COUNT(*) FILTER (WHERE status = 'kandidaat')::int AS te_onderzoeken,
        COUNT(*) FILTER (WHERE status = 'nieuw')::int AS te_keuren,
        COUNT(*) FILTER (WHERE status IN ${VERSTUURD})::int AS verstuurd,
        COUNT(*) FILTER (WHERE catalogus_at IS NOT NULL)::int AS catalogus,
        COUNT(*) FILTER (WHERE reply_at IS NOT NULL OR status IN ('reactie','afspraak','klant'))::int AS reacties,
        COUNT(*) FILTER (WHERE status IN ('afspraak','klant'))::int AS afspraken,
        COUNT(*) FILTER (WHERE status = 'klant')::int AS klanten,
        COUNT(*) FILTER (WHERE status = 'afgemeld')::int AS afgemeld,
        COUNT(*) FILTER (WHERE status = 'overgeslagen')::int AS overgeslagen
      FROM leads`),
    one(`SELECT
        (SELECT COUNT(*)::int FROM leads WHERE created_at >= ${T0}) AS gevonden,
        (SELECT COUNT(*)::int FROM leads WHERE researched_at >= ${T0}) AS onderzocht,
        (SELECT COUNT(*)::int FROM mail_log WHERE kind LIKE 'b2b-%' AND ok AND created_at >= ${T0}) AS verstuurd,
        (SELECT COUNT(*)::int FROM mail_log WHERE kind = 'b2b-opvolging' AND ok AND created_at >= ${T0}) AS opvolgingen,
        (SELECT COUNT(*)::int FROM leads WHERE reply_at >= ${T0}) AS reacties,
        (SELECT COUNT(DISTINCT lead_id)::int FROM mail_events WHERE soort = 'catalogus' AND created_at >= ${T0}) AS catalogus`),
    q(`SELECT COALESCE(NULLIF(category,''),'(geen)') AS naam, COUNT(*)::int AS gevonden, COUNT(*) FILTER (WHERE email IS NOT NULL)::int AS met_mail,
        COUNT(*) FILTER (WHERE status IN ${VERSTUURD})::int AS verstuurd, COUNT(*) FILTER (WHERE catalogus_at IS NOT NULL)::int AS catalogus,
        COUNT(*) FILTER (WHERE reply_at IS NOT NULL OR status IN ('reactie','afspraak','klant'))::int AS reacties
      FROM leads GROUP BY 1 ORDER BY gevonden DESC LIMIT 30`),
    q(`SELECT COALESCE(NULLIF(city,''),'(onbekend)') AS naam, COUNT(*)::int AS gevonden, COUNT(*) FILTER (WHERE email IS NOT NULL)::int AS met_mail,
        COUNT(*) FILTER (WHERE status IN ${VERSTUURD})::int AS verstuurd, COUNT(*) FILTER (WHERE reply_at IS NOT NULL OR status IN ('reactie','afspraak','klant'))::int AS reacties
      FROM leads GROUP BY 1 ORDER BY gevonden DESC LIMIT 15`),
    q(`WITH d AS (SELECT generate_series(0, 13) AS i), dag AS (SELECT to_char((NOW() AT TIME ZONE 'Europe/Amsterdam')::date - i, 'YYYY-MM-DD') AS dag FROM d)
       SELECT dag.dag,
        (SELECT COUNT(*)::int FROM leads WHERE to_char(created_at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') = dag.dag) AS gevonden,
        (SELECT COUNT(*)::int FROM mail_log WHERE kind LIKE 'b2b-%' AND ok AND to_char(created_at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') = dag.dag) AS verstuurd,
        (SELECT COUNT(*)::int FROM leads WHERE to_char(reply_at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') = dag.dag) AS reacties,
        (SELECT COUNT(DISTINCT lead_id)::int FROM mail_events WHERE soort = 'catalogus' AND to_char(created_at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') = dag.dag) AS catalogus
       FROM dag ORDER BY dag.dag`),
    one("SELECT COUNT(*) FILTER (WHERE status = 'goedgekeurd')::int AS eerste, COUNT(*) FILTER (WHERE status = 'opvolging_goedgekeurd')::int AS opvolging FROM leads"),
    one(`SELECT COUNT(*)::int AS n FROM leads WHERE status = 'verstuurd' AND reply_at IS NULL AND sent_at < NOW() - ($1 || ' days')::interval`, [String(Number(s.b2b.followupDays || 5))]),
  ]);
  const max = Number(s.b2b.dailyMax || 20);
  const [van, tot2] = s.b2b.sendHours || [8, 17];
  const now = new Date(), wd = new Date(dayKey(now) + "T12:00:00Z").getUTCDay(), h = hourAms(now);
  const weekend = wd === 0 || wd === 6;
  const venster = env("B2B_ANY_TIME") === "1" || (!weekend && h >= van && h < tot2);
  const rest = Math.max(0, max - vandaag.verstuurd);
  const cats = (sc.categories || []).filter(Boolean), places = (sc.places || []).filter(Boolean);
  const plan = cats.map((cat) => { const i = st.cursor?.[cat] || 0; return { categorie: cat, volgende: places.length ? places[i % places.length] : "", gedaan: places.length ? i % places.length : 0, rondes: places.length ? Math.floor(i / places.length) : 0 }; });
  return {
    scout: { klaar: scoutReady(), actief: !!sc.active, perDag: sc.perDay || 60, categorieen: cats, plaatsen: places, plan, laatsteDag: st.lastDay || null, bezig: (st.pending || []).length, geschiedenis: (st.history || []).slice(0, 25) },
    verzenden: { mail: mailReady(), max, vandaag: vandaag.verstuurd, rest, wachtrij, uren: [van, tot2], perUurNu: perUurVan(s.b2b), open: venster && mailReady(), weekend, autoGoedkeuren: !!s.b2b.autoGoedkeuren, opvolgingKlaar: opvolging.n },
    vandaag, totaal: tot, perCategorie: perCat, perPlaats, dagen, inbox, mail: await mailPrestaties(),
  };
}
