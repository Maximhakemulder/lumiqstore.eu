// Verkooporders en inkoop bij de leverancier.
// Order → behoefte per product → inkooporder: eerst uit de vrije voorraad bij de leverancier, de rest laten produceren (minimaal MOQ).
// Wat er boven de bestelling geproduceerd wordt (MOQ-overschot) blijft bij de leverancier liggen en telt als voorraad.
// Doorlooptijd: productie (standaard 21 dagen) + luchtvracht (standaard 7 dagen).
import { q, one, tx, getSettings, str, int, cents, addDays, dayKey, fail, audit, euro } from "./core.mjs";
import { standVan } from "./voorraad.mjs";

const jaar = () => dayKey().slice(0, 4);
const ORDER_STATUS = ["besteld", "in_productie", "onderweg", "binnen", "geleverd", "geannuleerd"];

// ================================================================ verkooporders
const TOTAAL_SQL = `(SELECT COALESCE(SUM(r.aantal * r.prijs_cents), 0)::bigint FROM order_regels r WHERE r.order_id = o.id) + o.verzend_cents - o.korting_cents`;
export async function orders({ status = "" } = {}) {
  return q(`SELECT o.*, k.bedrijf, k.plaats, ${TOTAAL_SQL} AS subtotaal_cents,
      (SELECT COALESCE(SUM(r.aantal), 0)::int FROM order_regels r WHERE r.order_id = o.id AND r.product_id IS NOT NULL) AS lampen,
      (SELECT COUNT(*)::int FROM order_regels r WHERE r.order_id = o.id AND r.product_id IS NOT NULL AND r.inkoop_id IS NULL) AS zonder_inkoop,
      (SELECT string_agg(DISTINCT i.nummer, ', ') FROM order_regels r JOIN inkooporders i ON i.id = r.inkoop_id WHERE r.order_id = o.id) AS inkoop,
      (SELECT f.status FROM facturen f WHERE f.order_id = o.id AND f.status <> 'gecrediteerd' ORDER BY f.id DESC LIMIT 1) AS factuur_status,
      (SELECT f.nummer FROM facturen f WHERE f.order_id = o.id AND f.status <> 'gecrediteerd' ORDER BY f.id DESC LIMIT 1) AS factuur
    FROM orders o JOIN klanten k ON k.id = o.klant_id
    WHERE ($1 = '' OR o.status = $1 OR ($1 = 'open' AND o.status NOT IN ('geleverd','geannuleerd'))) ORDER BY o.besteld_op DESC, o.id DESC LIMIT 500`, [status]);
}
export async function order(id) {
  const o = await one(`SELECT o.*, ${TOTAAL_SQL} AS subtotaal_cents FROM orders o WHERE o.id = $1`, [id]);
  if (!o) fail(404, "Order niet gevonden.");
  const klant = await one("SELECT * FROM klanten WHERE id = $1", [o.klant_id]);
  const regels = await q(`SELECT r.*, p.code, p.naam, p.serie, p.stijl, p.afbeelding, p.inkoop_cents, p.leverancier_code, i.nummer AS inkoop_nummer, i.status AS inkoop_status, i.binnen_verwacht
    FROM order_regels r LEFT JOIN producten p ON p.id = r.product_id LEFT JOIN inkooporders i ON i.id = r.inkoop_id WHERE r.order_id = $1 ORDER BY r.id`, [id]);
  const facturen = await q("SELECT id, nummer, status, totaal_cents, factuurdatum, vervaldatum, betaald_op FROM facturen WHERE order_id = $1 ORDER BY id", [id]);
  const inkoopwaarde = regels.reduce((t, r) => t + (r.product_id ? r.aantal * (r.inkoop_cents || 0) : 0), 0);
  return { order: o, klant, regels, facturen, marge: { inkoop_cents: inkoopwaarde, verkoop_cents: Number(o.subtotaal_cents), marge_cents: Number(o.subtotaal_cents) - inkoopwaarde } };
}
async function regelsVan(t, lijst) {
  const out = [];
  for (const r of Array.isArray(lijst) ? lijst : []) {
    const aantal = int(r.aantal);
    if (aantal <= 0) continue;
    const pid = int(r.product_id) || null;
    let prijs = r.prijs !== undefined && r.prijs !== "" ? cents(r.prijs) : null;
    let oms = str(r.omschrijving, 200);
    if (pid) {
      const p = await t.one("SELECT id, code, naam, stijl, serie, verkoop_cents FROM producten WHERE id = $1", [pid]);
      if (!p) fail(400, "Een product in de order bestaat niet (meer).");
      if (prijs === null) prijs = p.verkoop_cents;
      if (!oms) oms = `${p.serie} series ${p.stijl ? p.stijl + " " : ""}${p.naam} (${p.code})`;
    } else if (!oms) fail(400, "Een regel zonder product heeft een omschrijving nodig (bijv. laadtrolley of verzending).");
    out.push({ product_id: pid, omschrijving: oms, aantal, prijs_cents: prijs || 0 });
  }
  if (!out.length) fail(400, "Voeg minimaal één regel toe.");
  return out;
}
export async function orderMaken(b, userId) {
  return tx(async (t) => {
    let klantId = int(b.klant_id);
    if (!klantId) {
      const k = b.klant || {};
      if (!str(k.bedrijf)) fail(400, "Kies een klant of vul de naam van de zaak in.");
      klantId = (await t.one(`INSERT INTO klanten (bedrijf, contact, email, telefoon, adres, postcode, plaats, btw_nummer, lead_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [str(k.bedrijf, 200), str(k.contact, 120), str(k.email, 200).toLowerCase(), str(k.telefoon, 40), str(k.adres, 200), str(k.postcode, 20), str(k.plaats, 100), str(k.btw_nummer, 40), int(k.lead_id) || null])).id;
    } else if (!(await t.one("SELECT 1 FROM klanten WHERE id = $1", [klantId]))) fail(400, "Klant niet gevonden.");
    const regels = await regelsVan(t, b.regels);
    const seq = (await t.one("SELECT nextval('order_nummer_seq') AS n")).n;
    const o = await t.one(`INSERT INTO orders (nummer, klant_id, besteld_op, referentie, notities, verzend_cents, korting_cents, aanvraag_id, leverdatum)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [`ORD-${jaar()}-${String(seq).padStart(4, "0")}`, klantId, str(b.besteld_op, 10) || dayKey(), str(b.referentie, 120), str(b.notities, 2000), cents(b.verzend || 0), cents(b.korting || 0), int(b.aanvraag_id) || null, str(b.leverdatum, 10) || null]);
    for (const r of regels) await t.q("INSERT INTO order_regels (order_id, product_id, omschrijving, aantal, prijs_cents) VALUES ($1,$2,$3,$4,$5)", [o.id, r.product_id, r.omschrijving, r.aantal, r.prijs_cents]);
    if (b.aanvraag_id) await t.q("UPDATE aanvragen SET status = 'klant', klant_id = $2, updated_at = NOW() WHERE id = $1", [int(b.aanvraag_id), klantId]);
    const k = await t.one("SELECT lead_id FROM klanten WHERE id = $1", [klantId]);
    if (k?.lead_id) await t.q("UPDATE leads SET status = 'klant', klant_id = $2, updated_at = NOW() WHERE id = $1", [k.lead_id, klantId]);
    await audit(userId, "order.gemaakt", { id: o.id, nummer: o.nummer });
    return o;
  });
}
export async function orderBijwerken(id, b, userId) {
  return tx(async (t) => {
    const o = await t.one("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]);
    if (!o) fail(404, "Order niet gevonden.");
    const set = {};
    for (const k of ["referentie", "notities"]) if (b[k] !== undefined) set[k] = str(b[k], k === "notities" ? 2000 : 120);
    for (const k of ["leverdatum", "besteld_op"]) if (b[k] !== undefined) set[k] = str(b[k], 10) || null;
    if (b.verzend !== undefined) set.verzend_cents = cents(b.verzend);
    if (b.korting !== undefined) set.korting_cents = cents(b.korting);
    if (Array.isArray(b.regels)) {
      if (await t.one("SELECT 1 FROM order_regels WHERE order_id = $1 AND inkoop_id IS NOT NULL", [id])) fail(400, "Deze order zit al in een inkooporder; regels kun je niet meer aanpassen. Annuleer eerst de inkooporder (als die nog niet verzonden is).");
      const regels = await regelsVan(t, b.regels);
      await t.q("DELETE FROM order_regels WHERE order_id = $1", [id]);
      for (const r of regels) await t.q("INSERT INTO order_regels (order_id, product_id, omschrijving, aantal, prijs_cents) VALUES ($1,$2,$3,$4,$5)", [id, r.product_id, r.omschrijving, r.aantal, r.prijs_cents]);
    }
    if (b.status && b.status !== o.status) {
      if (!ORDER_STATUS.includes(b.status)) fail(400, "Onbekende status.");
      if (b.status === "geleverd") await leveren(t, o, userId);
      if (b.status === "geannuleerd") await annuleren(t, o);
      set.status = b.status;
      if (b.status === "geleverd") set.geleverd_op = str(b.geleverd_op, 10) || dayKey();
    }
    const keys = Object.keys(set);
    if (keys.length) await t.q(`UPDATE orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => set[k])]);
    await audit(userId, "order.gewijzigd", { id, ...set });
    return t.one("SELECT * FROM orders WHERE id = $1", [id]);
  });
}
// Geleverd aan de klant: de lampen gaan uit het magazijn (zijn eerder met de inkooporder binnengekomen).
async function leveren(t, o, userId) {
  const regels = await t.q(`SELECT r.product_id, SUM(r.aantal)::int AS aantal, p.code, BOOL_AND(r.inkoop_id IS NOT NULL AND i.status = 'ontvangen') AS binnen
    FROM order_regels r JOIN producten p ON p.id = r.product_id LEFT JOIN inkooporders i ON i.id = r.inkoop_id WHERE r.order_id = $1 GROUP BY r.product_id, p.code`, [o.id]);
  for (const r of regels) {
    const st = await standVan(t, r.product_id);
    if (st.magazijn < r.aantal) fail(400, `Er liggen ${st.magazijn} stuks van ${r.code} in het magazijn, de order heeft er ${r.aantal}. Zet eerst de inkooporder op "Ontvangen" of boek de voorraad bij.`);
    await t.q("INSERT INTO voorraad_mutaties (product_id, locatie, aantal, soort, ref, user_id) VALUES ($1,'magazijn',$2,'geleverd',$3,$4)", [r.product_id, -r.aantal, o.nummer, userId || null]);
  }
}
// Geannuleerd: haal de regels uit een inkooporder die nog niet verzonden is. Geproduceerde lampen blijven dan bij de leverancier.
async function annuleren(t, o) {
  if (o.status === "geleverd") fail(400, "Een geleverde order kun je niet annuleren. Maak een creditfactuur in Finance.");
  const regels = await t.q(`SELECT r.*, i.status AS po FROM order_regels r JOIN inkooporders i ON i.id = r.inkoop_id WHERE r.order_id = $1`, [o.id]);
  for (const r of regels) {
    if (["verzonden", "ontvangen"].includes(r.po)) continue; // al onderweg: de lampen komen in het magazijn
    await t.q(`UPDATE inkoop_regels SET voor_orders = GREATEST(0, voor_orders - $3), verzenden = GREATEST(0, verzenden - $3),
               uit_voorraad = GREATEST(0, uit_voorraad - $4) WHERE inkoop_id = $1 AND product_id = $2`, [r.inkoop_id, r.product_id, r.aantal, r.uit_voorraad]);
    await t.q("DELETE FROM inkoop_regels WHERE inkoop_id = $1 AND productie + uit_voorraad = 0", [r.inkoop_id]);
    await t.q("UPDATE order_regels SET inkoop_id = NULL, uit_voorraad = 0 WHERE id = $1", [r.id]);
  }
}

// ================================================================ inkoop
// Wat moet er nog besteld worden? Order-regels met een product, zonder inkooporder.
export async function behoefte() {
  const regels = await q(`SELECT r.id, r.order_id, r.product_id, r.aantal, o.nummer, o.besteld_op, k.bedrijf
    FROM order_regels r JOIN orders o ON o.id = r.order_id JOIN klanten k ON k.id = o.klant_id
    WHERE r.product_id IS NOT NULL AND r.inkoop_id IS NULL AND o.status IN ('besteld','in_productie') ORDER BY o.besteld_op, r.id`);
  const per = new Map();
  for (const r of regels) { const x = per.get(r.product_id) || { product_id: r.product_id, nodig: 0, regels: [] }; x.nodig += r.aantal; x.regels.push(r); per.set(r.product_id, x); }
  if (!per.size) return [];
  const prods = await q(`SELECT p.id, p.code, p.naam, p.serie, p.stijl, p.afbeelding, p.moq, p.inkoop_cents, p.leverancier_code,
      COALESCE((SELECT SUM(aantal) FROM voorraad_mutaties v WHERE v.product_id = p.id AND v.locatie = 'leverancier'), 0)::int
      - COALESCE((SELECT SUM(ir.uit_voorraad) FROM inkoop_regels ir JOIN inkooporders i ON i.id = ir.inkoop_id WHERE ir.product_id = p.id AND i.status IN ('concept','besteld','in_productie')), 0)::int AS vrij
    FROM producten p WHERE p.id = ANY($1)`, [[...per.keys()]]);
  return prods.map((p) => {
    const x = per.get(p.id), vrij = Math.max(0, p.vrij);
    const uit = Math.min(vrij, x.nodig), rest = x.nodig - uit;
    const productie = rest > 0 ? Math.max(p.moq, rest) : 0;
    return { ...p, vrij, nodig: x.nodig, uit_voorraad: uit, productie, overschot: productie + uit - x.nodig, orders: x.regels };
  }).sort((a, b) => a.serie - b.serie || a.code.localeCompare(b.code));
}

async function nieuwNummer(t) { const n = (await t.one("SELECT nextval('inkoop_nummer_seq') AS n")).n; return `PO-${jaar()}-${String(n).padStart(3, "0")}`; }

// Inkooporder (concept) maken uit de behoefte; optioneel alleen voor bepaalde producten.
export async function inkoopUitBehoefte(b, userId) {
  const s = await getSettings();
  const keuze = Array.isArray(b.product_ids) && b.product_ids.length ? new Set(b.product_ids.map(Number)) : null;
  const lijst = (await behoefte()).filter((x) => !keuze || keuze.has(x.id));
  if (!lijst.length) fail(400, "Er staat niets klaar om in te kopen.");
  return tx(async (t) => {
    const po = await t.one(`INSERT INTO inkooporders (nummer, leverancier, productie, productie_dagen, verzend_dagen, notities) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [await nieuwNummer(t), s.inkoop.leverancier, lijst.some((x) => x.productie > 0), int(s.inkoop.productieDagen, 21), int(s.inkoop.verzendDagen, 7), str(b.notities, 2000)]);
    for (const x of lijst) {
      await t.q("INSERT INTO inkoop_regels (inkoop_id, product_id, productie, uit_voorraad, voor_orders, verzenden, prijs_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [po.id, x.id, x.productie, x.uit_voorraad, x.nodig, x.nodig, x.inkoop_cents]);
      // Uit voorraad eerst toewijzen aan de oudste orders.
      let uit = x.uit_voorraad;
      for (const r of x.orders) {
        const deel = Math.min(uit, r.aantal); uit -= deel;
        await t.q("UPDATE order_regels SET inkoop_id = $2, uit_voorraad = $3 WHERE id = $1 AND inkoop_id IS NULL", [r.id, po.id, deel]);
      }
    }
    await audit(userId, "inkoop.gemaakt", { id: po.id, nummer: po.nummer });
    return po;
  });
}
// Handmatige inkooporder, bijv. voorraad aanvullen of overschot naar Nederland halen.
export async function inkoopHandmatig(b, userId) {
  const s = await getSettings();
  const regels = (Array.isArray(b.regels) ? b.regels : []).map((r) => ({ product_id: int(r.product_id), productie: Math.max(0, int(r.productie)), uit_voorraad: Math.max(0, int(r.uit_voorraad)), verzenden: r.verzenden === undefined || r.verzenden === "" ? null : Math.max(0, int(r.verzenden)), prijs: r.prijs })).filter((r) => r.product_id && r.productie + r.uit_voorraad > 0);
  if (!regels.length) fail(400, "Voeg minimaal één product toe met een aantal.");
  return tx(async (t) => {
    const po = await t.one(`INSERT INTO inkooporders (nummer, leverancier, productie, productie_dagen, verzend_dagen, notities) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [await nieuwNummer(t), str(b.leverancier, 120) || s.inkoop.leverancier, regels.some((r) => r.productie > 0), int(s.inkoop.productieDagen, 21), int(s.inkoop.verzendDagen, 7), str(b.notities, 2000)]);
    for (const r of regels) await regelOpslaan(t, po, r, true);
    await audit(userId, "inkoop.gemaakt", { id: po.id, nummer: po.nummer, handmatig: true });
    return po;
  });
}
async function regelOpslaan(t, po, r, nieuw = false) {
  const p = await t.one("SELECT id, code, moq, inkoop_cents FROM producten WHERE id = $1", [r.product_id]);
  if (!p) fail(400, "Product niet gevonden.");
  const oud = nieuw ? null : await t.one("SELECT * FROM inkoop_regels WHERE inkoop_id = $1 AND product_id = $2", [po.id, p.id]);
  if (r.productie > 0 && r.productie < p.moq && !r.onderMoq) fail(400, `${p.code}: de leverancier produceert minimaal ${p.moq} stuks (MOQ).`);
  // Uit voorraad kan alleen wat er vrij ligt bij de leverancier (eigen reservering telt mee).
  if (r.uit_voorraad > 0) {
    const vrij = (await t.one(`SELECT COALESCE((SELECT SUM(aantal) FROM voorraad_mutaties WHERE product_id = $1 AND locatie = 'leverancier'), 0)::int
      - COALESCE((SELECT SUM(ir.uit_voorraad) FROM inkoop_regels ir JOIN inkooporders i ON i.id = ir.inkoop_id WHERE ir.product_id = $1 AND i.status IN ('concept','besteld','in_productie') AND ir.inkoop_id <> $2), 0)::int AS v`, [p.id, po.id])).v;
    if (r.uit_voorraad > vrij) fail(400, `${p.code}: er ligt maar ${Math.max(0, vrij)} vrij bij de leverancier.`);
  }
  const voor = oud?.voor_orders || 0;
  const verzenden = r.verzenden === null || r.verzenden === undefined ? Math.max(voor, nieuw ? r.productie + r.uit_voorraad : oud?.verzenden ?? 0) : r.verzenden;
  if (verzenden < voor) fail(400, `${p.code}: er zijn ${voor} verkocht, die moeten mee naar Nederland.`);
  if (verzenden > r.productie + r.uit_voorraad) fail(400, `${p.code}: je kunt niet meer verzenden dan er geproduceerd + uit voorraad komt.`);
  const prijs = r.prijs !== undefined && r.prijs !== "" ? cents(r.prijs) : oud?.prijs_cents ?? p.inkoop_cents;
  if (oud) await t.q("UPDATE inkoop_regels SET productie = $2, uit_voorraad = $3, verzenden = $4, prijs_cents = $5 WHERE id = $1", [oud.id, r.productie, r.uit_voorraad, verzenden, prijs]);
  else await t.q("INSERT INTO inkoop_regels (inkoop_id, product_id, productie, uit_voorraad, voor_orders, verzenden, prijs_cents) VALUES ($1,$2,$3,$4,0,$5,$6)", [po.id, p.id, r.productie, r.uit_voorraad, verzenden, prijs]);
}

export async function inkooporders() {
  return q(`SELECT i.*, (SELECT COALESCE(SUM(productie), 0)::int FROM inkoop_regels r WHERE r.inkoop_id = i.id) AS productie_stuks,
      (SELECT COALESCE(SUM(uit_voorraad), 0)::int FROM inkoop_regels r WHERE r.inkoop_id = i.id) AS uit_voorraad_stuks,
      (SELECT COALESCE(SUM(verzenden), 0)::int FROM inkoop_regels r WHERE r.inkoop_id = i.id) AS verzend_stuks,
      (SELECT COALESCE(SUM(voor_orders), 0)::int FROM inkoop_regels r WHERE r.inkoop_id = i.id) AS verkocht_stuks,
      (SELECT COALESCE(SUM(productie * prijs_cents), 0)::bigint FROM inkoop_regels r WHERE r.inkoop_id = i.id) + i.vrachtkosten_cents AS waarde_cents,
      (SELECT COUNT(*)::int FROM inkoop_regels r WHERE r.inkoop_id = i.id) AS producten,
      (SELECT string_agg(DISTINCT o.nummer, ', ') FROM order_regels orr JOIN orders o ON o.id = orr.order_id WHERE orr.inkoop_id = i.id) AS orders
    FROM inkooporders i ORDER BY CASE i.status WHEN 'concept' THEN 0 WHEN 'besteld' THEN 1 WHEN 'in_productie' THEN 2 WHEN 'verzonden' THEN 3 ELSE 4 END, i.id DESC LIMIT 300`);
}
export async function inkooporder(id) {
  const po = await one("SELECT * FROM inkooporders WHERE id = $1", [id]);
  if (!po) fail(404, "Inkooporder niet gevonden.");
  const regels = await q(`SELECT r.*, p.code, p.naam, p.serie, p.stijl, p.afbeelding, p.moq, p.leverancier_code, (r.productie + r.uit_voorraad - r.verzenden) AS blijft
    FROM inkoop_regels r JOIN producten p ON p.id = r.product_id WHERE r.inkoop_id = $1 ORDER BY p.serie::int, p.code`, [id]);
  const orders = await q(`SELECT DISTINCT o.id, o.nummer, o.status, k.bedrijf FROM order_regels r JOIN orders o ON o.id = r.order_id JOIN klanten k ON k.id = o.klant_id WHERE r.inkoop_id = $1 ORDER BY o.nummer`, [id]);
  // Bestellijst om naar de leverancier te sturen (Engels, met hun modelnummers).
  const bestellijst = [`Purchase order ${po.nummer}${po.besteld_op ? ` (${po.besteld_op})` : ""}`, ""]
    .concat(regels.map((r) => `${r.leverancier_code || r.code} · Lumiq ${r.code} ${r.naam}: produce ${r.productie}${r.uit_voorraad ? `, from stock ${r.uit_voorraad}` : ""}, ship ${r.verzenden}${r.productie + r.uit_voorraad - r.verzenden > 0 ? `, keep in stock ${r.productie + r.uit_voorraad - r.verzenden}` : ""}`))
    .concat(["", "Shipping: air freight to the Netherlands."]).join("\n");
  return { inkoop: po, regels, orders, bestellijst };
}
export async function inkoopBijwerken(id, b, userId) {
  return tx(async (t) => {
    const po = await t.one("SELECT * FROM inkooporders WHERE id = $1 FOR UPDATE", [id]);
    if (!po) fail(404, "Inkooporder niet gevonden.");
    const set = {};
    for (const k of ["leverancier", "tracking", "notities"]) if (b[k] !== undefined) set[k] = str(b[k], k === "notities" ? 2000 : 200);
    if (b.vracht !== undefined) set.vrachtkosten_cents = cents(b.vracht);
    for (const k of ["productie_dagen", "verzend_dagen"]) if (b[k] !== undefined) set[k] = Math.max(0, int(b[k]));
    if (Array.isArray(b.regels)) {
      if (po.status !== "concept") fail(400, "Aantallen kun je alleen in een concept aanpassen.");
      for (const r of b.regels) await regelOpslaan(t, po, { product_id: int(r.product_id), productie: Math.max(0, int(r.productie)), uit_voorraad: Math.max(0, int(r.uit_voorraad)), verzenden: r.verzenden === "" || r.verzenden === undefined ? null : Math.max(0, int(r.verzenden)), prijs: r.prijs, onderMoq: !!r.onderMoq });
      set.productie = !!(await t.one("SELECT 1 FROM inkoop_regels WHERE inkoop_id = $1 AND productie > 0", [id]));
    }
    // Datums opnieuw uitrekenen als de doorlooptijd verandert.
    const pd = set.productie_dagen ?? po.productie_dagen, vd = set.verzend_dagen ?? po.verzend_dagen, prod = set.productie ?? po.productie;
    if (po.besteld_op && ["besteld", "in_productie"].includes(po.status)) { set.klaar_verwacht = addDays(po.besteld_op, prod ? pd : 0); set.binnen_verwacht = addDays(set.klaar_verwacht, vd); }
    if (po.verzonden_op && po.status === "verzonden" && set.verzend_dagen !== undefined) set.binnen_verwacht = addDays(po.verzonden_op, vd);
    const keys = Object.keys(set);
    if (keys.length) await t.q(`UPDATE inkooporders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => set[k])]);
    if (set.binnen_verwacht) await zetOrders(t, id, null, set.binnen_verwacht);
    await audit(userId, "inkoop.gewijzigd", { id, ...set, regels: undefined });
    return t.one("SELECT * FROM inkooporders WHERE id = $1", [id]);
  });
}
async function zetOrders(t, poId, status, leverdatum) {
  const ids = (await t.q("SELECT DISTINCT order_id FROM order_regels WHERE inkoop_id = $1", [poId])).map((r) => r.order_id);
  for (const oid of ids) {
    // Een order met regels in meerdere inkooporders volgt de traagste.
    const st = await t.one(`SELECT MIN(CASE i.status WHEN 'concept' THEN 0 WHEN 'besteld' THEN 1 WHEN 'in_productie' THEN 2 WHEN 'verzonden' THEN 3 WHEN 'ontvangen' THEN 4 ELSE 9 END) AS s,
        MAX(i.binnen_verwacht) AS binnen, BOOL_OR(r.inkoop_id IS NULL AND r.product_id IS NOT NULL) AS open
      FROM order_regels r LEFT JOIN inkooporders i ON i.id = r.inkoop_id WHERE r.order_id = $1 AND r.product_id IS NOT NULL`, [oid]);
    const map = { 0: "besteld", 1: "in_productie", 2: "in_productie", 3: "onderweg", 4: "binnen" };
    const nieuw = st.open ? "besteld" : map[st.s] || "besteld";
    await t.q(`UPDATE orders SET status = CASE WHEN status IN ('geleverd','geannuleerd') THEN status ELSE $2 END, leverdatum = COALESCE($3, leverdatum), updated_at = NOW() WHERE id = $1`,
      [oid, status && !st.open ? nieuw : nieuw, st.binnen || leverdatum || null]);
  }
}
const OVERGANG = { concept: ["besteld", "geannuleerd"], besteld: ["in_productie", "verzonden", "geannuleerd"], in_productie: ["verzonden", "geannuleerd"], verzonden: ["ontvangen"], ontvangen: [], geannuleerd: [] };
export async function inkoopStatus(id, b, userId) {
  const nieuw = String(b.status || "");
  return tx(async (t) => {
    const po = await t.one("SELECT * FROM inkooporders WHERE id = $1 FOR UPDATE", [id]);
    if (!po) fail(404, "Inkooporder niet gevonden.");
    if (!(OVERGANG[po.status] || []).includes(nieuw)) fail(400, `Van "${po.status}" naar "${nieuw}" kan niet.`);
    const datum = str(b.datum, 10) || dayKey();
    const regels = await t.q("SELECT r.*, p.code FROM inkoop_regels r JOIN producten p ON p.id = r.product_id WHERE r.inkoop_id = $1", [id]);
    const set = { status: nieuw };
    if (nieuw === "besteld") {
      if (!regels.length) fail(400, "Deze inkooporder heeft nog geen regels.");
      set.besteld_op = datum; set.klaar_verwacht = addDays(datum, po.productie ? po.productie_dagen : 0); set.binnen_verwacht = addDays(set.klaar_verwacht, po.verzend_dagen);
    }
    if (nieuw === "verzonden") {
      // Productie komt erbij bij de leverancier, de zending gaat eraf; het overschot blijft daar liggen.
      for (const r of regels) {
        const st = await standVan(t, r.product_id);
        if (st.leverancier + r.productie - r.verzenden < 0) fail(400, `${r.code}: er ligt niet genoeg bij de leverancier om ${r.verzenden} te verzenden.`);
        if (r.productie) await t.q("INSERT INTO voorraad_mutaties (product_id, locatie, aantal, soort, ref, user_id) VALUES ($1,'leverancier',$2,'productie',$3,$4)", [r.product_id, r.productie, po.nummer, userId || null]);
        if (r.verzenden) await t.q("INSERT INTO voorraad_mutaties (product_id, locatie, aantal, soort, ref, user_id) VALUES ($1,'leverancier',$2,'verzonden',$3,$4)", [r.product_id, -r.verzenden, po.nummer, userId || null]);
      }
      set.verzonden_op = datum; set.binnen_verwacht = addDays(datum, po.verzend_dagen);
      if (b.tracking !== undefined) set.tracking = str(b.tracking, 200);
    }
    if (nieuw === "ontvangen") {
      for (const r of regels) if (r.verzenden) await t.q("INSERT INTO voorraad_mutaties (product_id, locatie, aantal, soort, ref, user_id) VALUES ($1,'magazijn',$2,'ontvangen',$3,$4)", [r.product_id, r.verzenden, po.nummer, userId || null]);
      set.ontvangen_op = datum;
    }
    if (nieuw === "geannuleerd") {
      await t.q("UPDATE order_regels SET inkoop_id = NULL, uit_voorraad = 0 WHERE inkoop_id = $1", [id]);
    }
    const keys = Object.keys(set);
    await t.q(`UPDATE inkooporders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => set[k])]);
    if (nieuw === "geannuleerd") {
      const oids = (await t.q("SELECT DISTINCT o.id FROM orders o JOIN order_regels r ON r.order_id = o.id WHERE r.inkoop_id IS NULL AND o.status IN ('in_productie','besteld')")).map((r) => r.id);
      for (const oid of oids) await t.q("UPDATE orders SET status = 'besteld', updated_at = NOW() WHERE id = $1 AND status = 'in_productie' AND NOT EXISTS (SELECT 1 FROM order_regels r WHERE r.order_id = $1 AND r.inkoop_id IS NOT NULL)", [oid]);
    } else await zetOrders(t, id, nieuw, set.binnen_verwacht);
    await audit(userId, "inkoop.status", { id, nummer: po.nummer, status: nieuw });
    return t.one("SELECT * FROM inkooporders WHERE id = $1", [id]);
  });
}
export const fmt = euro;
