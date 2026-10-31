// Startpagina van Lumiq HQ: de belangrijkste cijfers per afdeling en wat er op jou wacht.
import { q, one, getSettings, getState, dayKey } from "./core.mjs";
import { mailReady } from "./mail.mjs";
import { scoutReady } from "./b2b.mjs";

const T0 = "(date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')";
export async function overzicht() {
  const s = await getSettings();
  const [b2b, cat, ord, ink, vr, fin, binnenkort, recent] = await Promise.all([
    one(`SELECT COUNT(*) FILTER (WHERE status = 'nieuw')::int AS te_keuren,
        COUNT(*) FILTER (WHERE status = 'kandidaat')::int AS te_onderzoeken,
        COUNT(*) FILTER (WHERE status IN ('reactie','interesse'))::int AS warm,
        (SELECT COUNT(*)::int FROM mail_log WHERE kind LIKE 'b2b-%' AND ok AND created_at >= ${T0}) AS vandaag,
        (SELECT COUNT(*)::int FROM mail_log WHERE kind LIKE 'b2b-%' AND ok AND created_at > NOW() - INTERVAL '7 days') AS week,
        (SELECT COUNT(*)::int FROM leads WHERE reply_at > NOW() - INTERVAL '7 days') AS reacties7
      FROM leads`),
    one(`SELECT COUNT(*) FILTER (WHERE soort = 'catalogus' AND created_at >= ${T0})::int AS vandaag,
        COUNT(*) FILTER (WHERE soort = 'catalogus' AND created_at > NOW() - INTERVAL '7 days')::int AS week,
        COUNT(*) FILTER (WHERE soort = 'catalogus')::int AS totaal,
        COUNT(*) FILTER (WHERE status = 'nieuw')::int AS nieuw,
        COUNT(*) FILTER (WHERE soort = 'offerte' AND status = 'nieuw')::int AS offertes_nieuw,
        (SELECT COUNT(DISTINCT lead_id)::int FROM mail_events WHERE soort = 'catalogus' AND created_at > NOW() - INTERVAL '7 days') AS via_mail7
      FROM aanvragen`),
    one(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('geleverd','geannuleerd'))::int AS open,
        COUNT(*) FILTER (WHERE status = 'besteld')::int AS besteld, COUNT(*) FILTER (WHERE status = 'in_productie')::int AS in_productie,
        COUNT(*) FILTER (WHERE status = 'onderweg')::int AS onderweg, COUNT(*) FILTER (WHERE status = 'binnen')::int AS binnen,
        (SELECT COUNT(*)::int FROM order_regels r JOIN orders o ON o.id = r.order_id WHERE r.product_id IS NOT NULL AND r.inkoop_id IS NULL AND o.status IN ('besteld','in_productie')) AS zonder_inkoop
      FROM orders`),
    one(`SELECT COUNT(*) FILTER (WHERE status = 'concept')::int AS concept, COUNT(*) FILTER (WHERE status IN ('besteld','in_productie'))::int AS productie,
        COUNT(*) FILTER (WHERE status = 'verzonden')::int AS onderweg, MIN(binnen_verwacht) FILTER (WHERE status IN ('besteld','in_productie','verzonden')) AS eerstvolgende
      FROM inkooporders`),
    one(`SELECT COALESCE(SUM(aantal) FILTER (WHERE locatie = 'leverancier'), 0)::int AS leverancier, COALESCE(SUM(aantal) FILTER (WHERE locatie = 'magazijn'), 0)::int AS magazijn,
        COALESCE(SUM(v.aantal * p.inkoop_cents) FILTER (WHERE locatie = 'leverancier'), 0)::bigint AS waarde_leverancier
      FROM voorraad_mutaties v JOIN producten p ON p.id = v.product_id`),
    one(`SELECT COALESCE(SUM(totaal_cents) FILTER (WHERE status = 'open'), 0)::bigint AS openstaand, COUNT(*) FILTER (WHERE status = 'open' AND vervaldatum < CURRENT_DATE)::int AS vervallen,
        COALESCE(SUM(subtotaal_cents) FILTER (WHERE status IN ('open','betaald') AND date_trunc('month', factuurdatum) = date_trunc('month', CURRENT_DATE)), 0)::bigint AS omzet_maand,
        (SELECT COUNT(*)::int FROM orders o WHERE o.status <> 'geannuleerd' AND NOT EXISTS (SELECT 1 FROM facturen f WHERE f.order_id = o.id AND f.status <> 'gecrediteerd')) AS te_factureren
      FROM facturen`),
    q(`SELECT i.id, i.nummer, i.status, i.binnen_verwacht, i.klaar_verwacht FROM inkooporders i WHERE i.status IN ('besteld','in_productie','verzonden') ORDER BY i.binnen_verwacht NULLS LAST LIMIT 6`),
    q(`(SELECT 'aanvraag' AS soort, id, created_at, soort || ': ' || COALESCE(NULLIF(bedrijf,''), naam) AS tekst FROM aanvragen ORDER BY created_at DESC LIMIT 6)
       UNION ALL (SELECT 'reactie', id, reply_at, 'Reactie: ' || company FROM leads WHERE reply_at IS NOT NULL ORDER BY reply_at DESC LIMIT 6)
       UNION ALL (SELECT 'order', id, created_at, 'Order ' || nummer FROM orders ORDER BY created_at DESC LIMIT 6)
       ORDER BY created_at DESC LIMIT 10`),
  ]);
  const wacht = [];
  if (b2b.te_keuren) wacht.push({ tekst: `${b2b.te_keuren} horecazaken klaar om te mailen: keur ze goed`, link: "#b2b/leads/nieuw" });
  if (b2b.warm) wacht.push({ tekst: `${b2b.warm} warme leads (reactie of catalogus geopend): bellen`, link: "#b2b/leads/warm" });
  if (cat.nieuw) wacht.push({ tekst: `${cat.nieuw} nieuwe aanvragen via de website`, link: "#aanvragen" });
  if (ord.zonder_inkoop) wacht.push({ tekst: `${ord.zonder_inkoop} orderregels nog niet ingekocht`, link: "#inkoop" });
  if (ink.concept) wacht.push({ tekst: `${ink.concept} inkooporder(s) in concept: bestel bij de leverancier`, link: "#inkoop" });
  if (ord.binnen) wacht.push({ tekst: `${ord.binnen} order(s) binnen in het magazijn: leveren`, link: "#orders" });
  if (fin.te_factureren) wacht.push({ tekst: `${fin.te_factureren} order(s) nog niet gefactureerd`, link: "#finance" });
  if (fin.vervallen) wacht.push({ tekst: `${fin.vervallen} factuur/facturen over de vervaldatum`, link: "#finance" });
  const instellen = [];
  if (!mailReady()) instellen.push("Zet MAIL_USER en MAIL_PASSWORD (armand@lumiqstore.com) in Netlify: dan werken inloggen, B2B-mail en facturen.");
  if (!scoutReady()) instellen.push("Zet OUTSCRAPER_API_KEY in Netlify: dan zoekt de scout elke werkdag horecazaken.");
  if (!s.company.iban) instellen.push("Vul het IBAN in bij Instellingen › Bedrijf: dat staat op de facturen.");
  if (!s.b2b.scout?.active) instellen.push("De scout staat uit. Zet hem aan bij Instellingen › B2B als je klaar bent.");
  const pulse = await getState("tick_pulse", null);
  return { b2b, catalogus: cat, orders: ord, inkoop: ink, voorraad: vr, finance: fin, binnenkort, recent, wacht, instellen, pulse, vandaag: dayKey() };
}
