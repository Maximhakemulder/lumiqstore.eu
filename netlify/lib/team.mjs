// Het AI-team van Lumiq: per afdeling een AI-medewerker die met een echt persoon samenwerkt.
// - Iedere afdeling heeft een "stand" (cijfers + lijstjes uit de database) waar de AI-medewerker op antwoordt.
// - Vera (directie) schrijft op werkdagen om 7:30 een ochtendbriefing met taken per persoon.
// - Vragen aan een afdeling worden direct beantwoord; lukt dat niet binnen ~8 s, dan doet `tick` het.
// Zonder AI (geen AI Gateway) werkt alles ook: de briefing wordt dan uit de cijfers opgebouwd.
import { q, one, env, getSettings, dayKey, hourAms, euro, str, fail, audit, escH } from "./core.mjs";
import { claude, aiReady, parseJson } from "./ai.mjs";
import { overzicht } from "./overzicht.mjs";
import { b2bDashboard } from "./b2bstats.mjs";
import * as cat from "./catalogus.mjs";
import * as handel from "./handel.mjs";
import * as fin from "./finance.mjs";
import { voorraad as voorraadStand } from "./voorraad.mjs";
import { sendMail, brandHtml, mailReady } from "./mail.mjs";

// Standaardteam. Namen en wie erbij hoort zijn aan te passen via Instellingen › Team (settings.team).
export const AFDELINGEN = [
  { key: "directie", ai: "Vera", rol: "Directeur", mens: "Maxim", link: "#overzicht", taak: "Houdt het overzicht over heel Lumiq, schrijft elke werkdag de ochtendbriefing en zet de prioriteiten." },
  { key: "b2b", ai: "Daan", rol: "B2B Sales", mens: "Armand", link: "#b2b", taak: "Zoekt horecazaken, bewaakt de mailmachine en zegt wie je vandaag moet bellen (catalogus geopend, reacties)." },
  { key: "aanvragen", ai: "Noor", rol: "Catalogus & aanvragen", mens: "Armand", link: "#aanvragen", taak: "Volgt iedereen op die via de website de catalogus of een offerte aanvraagt." },
  { key: "inkoop", ai: "Ruben", rol: "Inkoop & voorraad", mens: "Armand", link: "#inkoop", taak: "Bestelt bij de leverancier (MOQ 50, 21 dagen productie + 7 dagen vlucht) en houdt de restvoorraad bij de leverancier bij." },
  { key: "orders", ai: "Lotte", rol: "Orders & levering", mens: "Armand", link: "#orders", taak: "Volgt elke order van bestelling tot levering bij de klant." },
  { key: "finance", ai: "Bram", rol: "Finance", mens: "Maxim", link: "#finance", taak: "Factureert, bewaakt betalingen en marges en stuurt herinneringen." },
];
export const MENSEN = { Maxim: "maxim@gosmart.eu", Armand: "armand@lumiqstore.com" };

export async function team() {
  const s = await getSettings();
  const t = s.team || {};
  const afd = AFDELINGEN.map((a) => ({ ...a, ai: t.namen?.[a.key] || a.ai, mens: t.mensen?.[a.key] || a.mens }));
  return { afdelingen: afd, mensen: { ...MENSEN, ...(t.mail || {}) }, briefingMail: t.briefingMail !== false };
}
const afdelingVan = async (key) => { const a = (await team()).afdelingen.find((x) => x.key === key); if (!a) fail(404, "Onbekende afdeling."); return a; };

// ---------------------------------------------------------------- stand per afdeling (data voor de AI en de kaarten)
const kort = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
export async function stand(key) {
  if (key === "b2b") {
    const d = await b2bDashboard();
    const warm = await q(`SELECT company, city, category, phone, email, status, catalogus_at, reply_at, LEFT(reply_snippet, 160) AS reactie FROM leads WHERE status IN ('reactie','interesse','afspraak') ORDER BY COALESCE(reply_at, catalogus_at) DESC NULLS LAST LIMIT 12`);
    return { totaal: d.totaal, mail7dagen: d.mail.d7, mail30dagen: d.mail.d30, vandaag: d.vandaag, verzenden: { ...d.verzenden }, scout: { actief: d.scout.actief, klaar: d.scout.klaar, perDag: d.scout.perDag }, waarschuwingen: d.mail.waarschuwingen,
      warmeLeads: warm.map((l) => ({ ...l, catalogus_at: kort(l.catalogus_at), reply_at: kort(l.reply_at) })), perCategorie: d.perCategorie.slice(0, 6) };
  }
  if (key === "aanvragen") {
    const d = await cat.lijst();
    return { stats: d.stats, perBron: d.perBron, openAanvragen: d.aanvragen.filter((a) => a.status === "nieuw").slice(0, 15).map((a) => ({ soort: a.soort, naam: a.naam, zaak: a.bedrijf, telefoon: a.telefoon, email: a.email, tafels: a.tafels, demo: a.demo, gedownload: a.downloads, binnen: kort(a.created_at) })),
      catalogusViaMail: d.mailLeads.slice(0, 10).map((l) => ({ zaak: l.company, plaats: l.city, telefoon: l.phone, status: l.status, keer: l.keer })) };
  }
  if (key === "inkoop") {
    const [b, po, v] = await Promise.all([handel.behoefte(), handel.inkooporders(), voorraadStand()]);
    return { nogInTeKopen: b.map((x) => ({ model: `${x.serie} ${x.naam} (${x.code})`, verkocht: x.nodig, vrijBijLeverancier: x.vrij, uitVoorraad: x.uit_voorraad, produceren: x.productie, blijftBijLeverancier: x.overschot })),
      inkooporders: po.filter((p) => !["ontvangen", "geannuleerd"].includes(p.status)).map((p) => ({ nummer: p.nummer, status: p.status, besteld: kort(p.besteld_op), klaarVerwacht: kort(p.klaar_verwacht), binnenVerwacht: kort(p.binnen_verwacht), produceren: p.productie_stuks, naarNL: p.verzend_stuks, voorOrders: p.orders })),
      voorraad: v.totaal, restBijLeverancier: v.producten.filter((p) => p.vrij_bij_leverancier > 0).slice(0, 20).map((p) => ({ model: `${p.serie} ${p.naam} (${p.code})`, vrij: p.vrij_bij_leverancier })),
      zonderPrijs: (await one("SELECT COUNT(*)::int AS n FROM producten WHERE actief AND (inkoop_cents = 0 OR verkoop_cents = 0)")).n };
  }
  if (key === "orders") {
    const o = await handel.orders({ status: "open" });
    return { open: o.map((x) => ({ nummer: x.nummer, klant: x.bedrijf, plaats: x.plaats, status: x.status, besteld: kort(x.besteld_op), leverdatum: kort(x.leverdatum), lampen: x.lampen, bedrag: euro(x.subtotaal_cents), nogInkopen: !!x.zonder_inkoop, factuur: x.factuur_status || "geen" })) };
  }
  if (key === "finance") {
    const f = await fin.overzicht();
    return { totaal: Object.fromEntries(Object.entries(f.totaal).map(([k, v]) => [k, /_n$/.test(k) ? v : euro(v)])), teFactureren: f.teFactureren.map((o) => ({ order: o.nummer, klant: o.bedrijf, bedrag: euro(o.subtotaal_cents), status: o.status })),
      openFacturen: f.facturen.filter((x) => x.status === "open").slice(0, 20).map((x) => ({ nummer: x.nummer, klant: x.bedrijf, bedrag: euro(x.totaal_cents), vervalt: kort(x.vervaldatum), vervallen: !!x.vervallen, verstuurd: !!x.verzonden_at, herinneringen: x.herinneringen })),
      maanden: f.maanden.slice(-3).map((m) => ({ maand: m.maand, omzet: euro(m.omzet), inkoop: euro(m.inkoop), ontvangen: euro(m.ontvangen) })) };
  }
  // directie: alles, compact
  const o = await overzicht();
  return { vandaag: dayKey(), b2b: o.b2b, catalogus: o.catalogus, orders: o.orders, inkoop: o.inkoop, voorraad: o.voorraad, finance: Object.fromEntries(Object.entries(o.finance).map(([k, v]) => [k, /cents|openstaand|omzet/.test(k) ? euro(v) : v])),
    wachtOpJullie: o.wacht.map((w) => w.tekst), nogInTeStellen: o.instellen };
}

// Drie cijfers per afdeling voor de kaarten op de Team-pagina.
export async function kaarten() {
  const o = await overzicht();
  return {
    directie: [[o.wacht.length, "punten open"], [o.orders.open, "orders lopen"], [euro(o.finance.openstaand).replace(/,\d\d$/, ""), "openstaand"]],
    b2b: [[o.b2b.vandaag, "mails vandaag"], [o.b2b.warm, "warme leads"], [o.b2b.te_keuren, "te keuren"]],
    aanvragen: [[o.catalogus.week, "catalogus 7 d"], [o.catalogus.nieuw, "op te volgen"], [o.catalogus.via_mail7, "via mail geopend"]],
    inkoop: [[o.orders.zonder_inkoop, "regels in te kopen"], [o.inkoop.productie, "in productie"], [o.voorraad.leverancier, "bij leverancier"]],
    orders: [[o.orders.open, "open"], [o.orders.onderweg, "onderweg"], [o.orders.binnen, "klaar om te leveren"]],
    finance: [[o.finance.te_factureren, "te factureren"], [o.finance.vervallen, "vervallen"], [euro(o.finance.omzet_maand).replace(/,\d\d$/, ""), "omzet maand"]],
  };
}

// ---------------------------------------------------------------- vragen aan een afdeling
const LUMIQ = `Lumiq (lumiqstore.com, Gosmart B.V.) verkoopt draadloze, oplaadbare tafellampen B2B aan de horeca (restaurants, hotels, beach clubs, bars). 12 series, 64 modellen, bediening van 20 tot 200 lampen via app of touchpaneel.
Inkoop bij een Chinese leverancier: minimaal 50 stuks per model (MOQ); wat niet verkocht is blijft als voorraad bij de leverancier. Productie ± 21 dagen, daarna ± 7 dagen luchtvracht.
Alle cijfers komen uit Lumiq HQ. Bedragen zijn excl. btw tenzij anders vermeld.`;
function systeem(a, alle) {
  const collega = alle.filter((x) => x.key !== a.key).map((x) => `${x.ai} (${x.rol}, met ${x.mens})`).join(", ");
  return `${LUMIQ}

Je bent ${a.ai}, AI-medewerker ${a.rol} bij Lumiq. Je werkt samen met ${a.mens}. Jouw taak: ${a.taak}
Collega's: ${collega}.
Antwoord in het Nederlands, kort en concreet (max. ~180 woorden), met namen, aantallen en datums uit de data. Je mag opsommingen gebruiken (regels die met "- " beginnen).
Gebruik ALLEEN de data hieronder; staat iets er niet in, zeg dat eerlijk en zeg waar ${a.mens} het in HQ kan vinden of invullen. Verzin nooit klanten, prijzen of datums.
Je voert zelf niets uit (geen mails, geen bestellingen); je adviseert en zegt wat ${a.mens} kan doen.`;
}
async function beantwoord(v, budgetMs = 20000) {
  const { afdelingen } = await team();
  const a = afdelingen.find((x) => x.key === v.afdeling) || afdelingen[0];
  if (!aiReady()) {
    await q("UPDATE team_vragen SET status = 'fout', antwoord = $2, beantwoord_at = NOW() WHERE id = $1", [v.id, "De AI staat nog uit. Zet de AI Gateway aan in Netlify, dan kan ik je vragen beantwoorden."]);
    return;
  }
  await q("UPDATE team_vragen SET pogingen = pogingen + 1 WHERE id = $1", [v.id]);
  const eerder = await q("SELECT vraag, antwoord FROM team_vragen WHERE afdeling = $1 AND status = 'klaar' AND id < $2 ORDER BY id DESC LIMIT 3", [v.afdeling, v.id]);
  const data = await stand(v.afdeling);
  const prompt = `Data van vandaag (${dayKey()}):\n${JSON.stringify(data).slice(0, 14000)}\n\n${eerder.length ? `Eerdere vragen (oud → nieuw):\n${eerder.reverse().map((e) => `V: ${e.vraag}\nA: ${e.antwoord.slice(0, 400)}`).join("\n")}\n\n` : ""}Vraag van ${v.door || a.mens}: ${v.vraag}`;
  try {
    const antwoord = await claude({ system: systeem(a, afdelingen), prompt, model: env("AI_MODEL", "claude-sonnet-5-5"), maxTokens: 900, timeoutMs: budgetMs });
    await q("UPDATE team_vragen SET status = 'klaar', antwoord = $2, beantwoord_at = NOW() WHERE id = $1", [v.id, antwoord || "Ik heb hier geen antwoord op."]);
  } catch (e) {
    if (v.pogingen >= 2) await q("UPDATE team_vragen SET status = 'fout', antwoord = $2, beantwoord_at = NOW() WHERE id = $1", [v.id, `Dat lukte niet (${e.message}). Stel je vraag zo nog een keer.`]);
  }
}
export async function vraagStellen(afdeling, vraag, door) {
  await afdelingVan(afdeling);
  const tekst = str(vraag, 1500);
  if (!tekst) fail(400, "Typ eerst je vraag.");
  const v = await one("INSERT INTO team_vragen (afdeling, vraag, door) VALUES ($1, $2, $3) RETURNING *", [afdeling, tekst, str(door, 40)]);
  await beantwoord(v, 8500).catch(() => {});
  return one("SELECT * FROM team_vragen WHERE id = $1", [v.id]);
}
export const vragen = (afdeling) => q("SELECT id, afdeling, vraag, antwoord, status, door, created_at, beantwoord_at FROM team_vragen WHERE afdeling = $1 ORDER BY id DESC LIMIT 30", [afdeling]);
export async function runOpenVragen({ max = 2, budgetMs = 9000 } = {}) {
  const open = await q("SELECT * FROM team_vragen WHERE status = 'open' AND created_at < NOW() - INTERVAL '10 seconds' ORDER BY id LIMIT $1", [max]);
  const t0 = Date.now();
  for (const v of open) { if (Date.now() - t0 > budgetMs - 2000) break; await beantwoord(v, Math.max(4000, budgetMs - (Date.now() - t0))); }
  return { beantwoord: open.length };
}

// ---------------------------------------------------------------- ochtendbriefing (Vera) + taken
// Vaste routine per persoon. "als" = alleen tonen als er iets te doen is (getal uit het overzicht).
const mv = (n, een, meer) => `${n} ${Number(n) === 1 ? een : meer}`;
const ROUTINE = [
  { id: "leads-keuren", wie: "b2b", tekst: (o) => `${mv(o.b2b.te_keuren, "nieuwe horecazaak", "nieuwe horecazaken")} keuren`, als: (o) => o.b2b.te_keuren, link: "#b2b/leads/nieuw" },
  { id: "warm-bellen", wie: "b2b", tekst: (o) => `${mv(o.b2b.warm, "warme lead", "warme leads")} bellen (catalogus geopend of gereageerd)`, als: (o) => o.b2b.warm, link: "#b2b/leads/warm" },
  { id: "aanvragen", wie: "aanvragen", tekst: (o) => `${mv(o.catalogus.nieuw, "aanvraag", "aanvragen")} van de website opvolgen`, als: (o) => o.catalogus.nieuw, link: "#aanvragen" },
  { id: "inkopen", wie: "inkoop", tekst: (o) => `${mv(o.orders.zonder_inkoop, "orderregel", "orderregels")} inkopen bij de leverancier`, als: (o) => o.orders.zonder_inkoop, link: "#inkoop" },
  { id: "po-bestellen", wie: "inkoop", tekst: (o) => `${mv(o.inkoop.concept, "inkooporder", "inkooporders")} in concept naar de leverancier sturen`, als: (o) => o.inkoop.concept, link: "#inkoop" },
  { id: "leveren", wie: "orders", tekst: (o) => `${mv(o.orders.binnen, "order is", "orders zijn")} binnen: levering met de klant inplannen`, als: (o) => o.orders.binnen, link: "#orders" },
  { id: "factureren", wie: "finance", tekst: (o) => `${mv(o.finance.te_factureren, "order", "orders")} factureren`, als: (o) => o.finance.te_factureren, link: "#finance" },
  { id: "vervallen", wie: "finance", tekst: (o) => `${mv(o.finance.vervallen, "vervallen factuur", "vervallen facturen")} nabellen`, als: (o) => o.finance.vervallen, link: "#finance" },
  { id: "week-cijfers", wie: "directie", tekst: () => "Weekcijfers doornemen: mails, catalogus, orders, omzet", als: () => new Date().getDay() === 1, link: "#overzicht" },
];
function zonderAi(o, afdelingen) {
  const per = Object.fromEntries(afdelingen.map((a) => [a.key, a]));
  const punten = ROUTINE.filter((r) => r.als(o)).map((r) => ({ afdeling: r.wie, tekst: r.tekst(o) }));
  return {
    samenvatting: punten.length ? `Vandaag ${punten.length} punten: ${punten.slice(0, 3).map((p) => p.tekst.toLowerCase()).join("; ")}.` : "Rustige dag: niets dringends. Tijd om nieuwe horecazaken te benaderen.",
    afdelingen: afdelingen.map((a) => ({ afdeling: a.key, tekst: punten.filter((p) => p.afdeling === a.key).map((p) => p.tekst).join(". ") || "Niets bijzonders." })),
    taken: [], // de vaste taken staan al op de takenlijst
  };
}
export async function maakBriefing({ force = false, budgetMs = 9000 } = {}) {
  const dag = dayKey();
  if (!force && (await one("SELECT 1 FROM team_briefings WHERE dag = $1", [dag]))) return { al: true };
  const { afdelingen } = await team();
  const o = await overzicht();
  let inhoud = null, bron = "cijfers";
  if (aiReady()) {
    try {
      const data = {}; for (const a of afdelingen) if (a.key !== "directie") data[a.key] = await stand(a.key);
      const vera = afdelingen.find((a) => a.key === "directie");
      const out = await claude({
        system: systeem(vera, afdelingen), model: env("AI_MODEL", "claude-sonnet-5-5"), maxTokens: 1600, timeoutMs: Math.max(5000, budgetMs - 1000),
        prompt: `Schrijf de ochtendbriefing van ${dag} voor ${[...new Set(afdelingen.map((a) => a.mens))].join(" en ")}.
Data per afdeling:\n${JSON.stringify(data).slice(0, 16000)}\n\nWacht op jullie: ${JSON.stringify(o.wacht.map((w) => w.tekst))}
Antwoord alleen met JSON: {"samenvatting":"2-3 zinnen: hoe staat Lumiq ervoor en wat is vandaag het belangrijkste","afdelingen":[{"afdeling":"b2b|aanvragen|inkoop|orders|finance","tekst":"1-2 zinnen namens die AI-collega"}],"taken":[{"wie":"Armand|Maxim","afdeling":"...","tekst":"concrete taak met naam/aantal"}]}
Deze vaste taken staan AL op de takenlijst, herhaal ze niet: ${JSON.stringify(ROUTINE.filter((r) => r.als(o)).map((r) => r.tekst(o)))}.
Geef alleen aanvullende, concrete taken (bijv. welke zaak bellen, welke factuur nabellen, welke order inplannen). Max. 6, belangrijkste eerst; geen taken als er niets extra's is. Verzin niets.`,
      });
      const j = parseJson(out);
      if (j?.samenvatting) { inhoud = j; bron = "ai"; }
    } catch (e) { console.log("[briefing]", e.message); }
  }
  inhoud ||= zonderAi(o, afdelingen);
  inhoud.taken = (inhoud.taken || []).slice(0, 10).map((t, i) => ({ id: `b${i}`, wie: str(t.wie, 30), afdeling: str(t.afdeling, 20), tekst: str(t.tekst, 300) }));
  await q("INSERT INTO team_briefings (dag, inhoud, bron) VALUES ($1, $2, $3) ON CONFLICT (dag) DO UPDATE SET inhoud = EXCLUDED.inhoud, bron = EXCLUDED.bron, created_at = NOW()", [dag, JSON.stringify(inhoud), bron]);
  return { dag, bron };
}
export async function briefing(dag = dayKey()) {
  return (await one("SELECT dag, inhoud, bron, created_at FROM team_briefings WHERE dag <= $1 ORDER BY dag DESC LIMIT 1", [dag])) || null;
}

// Taken van vandaag per persoon: vaste routine (alleen als er iets te doen is) + taken uit de briefing.
export async function taken(dag = dayKey()) {
  const [{ afdelingen }, o, b, gedaan] = await Promise.all([team(), overzicht(), briefing(dag), q("SELECT taak_id, door, gedaan_at FROM team_taken WHERE dag = $1", [dag])]);
  const per = Object.fromEntries(afdelingen.map((a) => [a.key, a]));
  const klaar = Object.fromEntries(gedaan.map((g) => [g.taak_id, g]));
  const lijst = ROUTINE.filter((r) => r.als(o) || klaar[r.id]).map((r) => ({ id: r.id, wie: per[r.wie]?.mens || "Maxim", afdeling: r.wie, ai: per[r.wie]?.ai, tekst: r.tekst(o), link: r.link, bron: "routine" }));
  if (b && kort(b.dag) === dag) for (const t of b.inhoud.taken || []) lijst.push({ ...t, ai: per[t.afdeling]?.ai, link: per[t.afdeling]?.link || "#overzicht", bron: "briefing" });
  const mensen = [...new Set(afdelingen.map((a) => a.mens))];
  return { dag, mensen, taken: lijst.map((t) => ({ ...t, gedaan: klaar[t.id] ? { door: klaar[t.id].door, at: klaar[t.id].gedaan_at } : null })) };
}
export async function vink(dag, taakId, gedaan, door) {
  const id = str(taakId, 60); if (!id) fail(400, "Geen taak.");
  const d = /^\d{4}-\d\d-\d\d$/.test(String(dag)) ? dag : dayKey();
  if (gedaan) await q("INSERT INTO team_taken (dag, taak_id, door) VALUES ($1, $2, $3) ON CONFLICT (dag, taak_id) DO UPDATE SET door = EXCLUDED.door, gedaan_at = NOW()", [d, id, str(door, 40)]);
  else await q("DELETE FROM team_taken WHERE dag = $1 AND taak_id = $2", [d, id]);
  return { ok: true };
}

// Werkdagen vanaf 7:30: briefing maken en (één keer) mailen naar het team.
export async function runOchtend({ budgetMs = 9000 } = {}) {
  const nu = new Date(); const dag = dayKey(nu);
  const wd = new Date(dag + "T12:00:00Z").getUTCDay();
  const minuut = Number(nu.toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", minute: "2-digit" }));
  if (wd === 0 || wd === 6 || hourAms(nu) < 7 || (hourAms(nu) === 7 && minuut < 30)) return { wacht: true };
  const r = await maakBriefing({ budgetMs });
  const t = await team();
  if (!t.briefingMail || !mailReady()) return r;
  const al = await one("SELECT 1 FROM mail_log WHERE kind = 'briefing' AND ok AND created_at::date = CURRENT_DATE");
  if (al) return r;
  const b = await briefing(dag); const tk = await taken(dag);
  const vera = t.afdelingen.find((a) => a.key === "directie");
  for (const [naam, email] of Object.entries(t.mensen)) {
    if (!email) continue;
    const mijn = tk.taken.filter((x) => x.wie === naam && !x.gedaan);
    const regels = [escH(b.inhoud.samenvatting), mijn.length ? `<b>Jouw taken vandaag:</b><br>${mijn.map((x) => "• " + escH(x.tekst)).join("<br>")}` : "Geen taken voor jou vandaag."];
    await sendMail({ to: email, kind: "briefing", subject: `Ochtendbriefing ${new Date(dag + "T12:00:00Z").toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" })}`, fromName: `${vera.ai} · Directie | Lumiq`,
      text: `${b.inhoud.samenvatting}\n\n${mijn.length ? "Jouw taken vandaag:\n" + mijn.map((x) => "- " + x.tekst).join("\n") : "Geen taken voor jou vandaag."}\n\nOpen Lumiq HQ: ${(env("PUBLIC_BASE_URL") || "").replace(/\/$/, "")}/hq/#team\n\n${vera.ai}, AI-directeur Lumiq`,
      html: brandHtml({ title: `Goedemorgen ${naam}`, intro: regels, button: { label: "Open het team in HQ", href: `${(env("PUBLIC_BASE_URL") || "").replace(/\/$/, "")}/hq/#team` }, footnote: `${vera.ai}, AI-directeur Lumiq` }) });
  }
  await audit(null, "briefing.mail", { dag });
  return { ...r, gemaild: true };
}
