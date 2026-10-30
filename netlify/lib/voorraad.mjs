// Producten, klanten en voorraad. Voorraad = som van mutaties per product en locatie:
// "leverancier" (ligt bij de fabriek in China, bijv. het MOQ-overschot) en "magazijn" (ligt in Nederland).
import { q, one, tx, str, int, cents, fail, audit } from "./core.mjs";

// ---------------------------------------------------------------- producten
export async function producten({ alleenActief = false } = {}) {
  return q(`SELECT p.*, ${STAND_SQL} FROM producten p ${STAND_JOIN} WHERE ($1 = FALSE OR p.actief) ORDER BY p.serie::int, p.code`, [alleenActief]);
}
const STAND_JOIN = `
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(aantal) FILTER (WHERE locatie = 'leverancier'), 0)::int AS bij_leverancier,
                            COALESCE(SUM(aantal) FILTER (WHERE locatie = 'magazijn'), 0)::int AS in_magazijn
                     FROM voorraad_mutaties v WHERE v.product_id = p.id) s ON TRUE
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(r.uit_voorraad), 0)::int AS gereserveerd
                     FROM inkoop_regels r JOIN inkooporders i ON i.id = r.inkoop_id
                     WHERE r.product_id = p.id AND i.status IN ('concept','besteld','in_productie')) g ON TRUE
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(r.verzenden), 0)::int AS onderweg
                     FROM inkoop_regels r JOIN inkooporders i ON i.id = r.inkoop_id
                     WHERE r.product_id = p.id AND i.status = 'verzonden') o ON TRUE
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(r.productie), 0)::int AS in_productie
                     FROM inkoop_regels r JOIN inkooporders i ON i.id = r.inkoop_id
                     WHERE r.product_id = p.id AND i.status IN ('besteld','in_productie')) ip ON TRUE`;
const STAND_SQL = `s.bij_leverancier, s.in_magazijn, g.gereserveerd, (s.bij_leverancier - g.gereserveerd) AS vrij_bij_leverancier, o.onderweg, ip.in_productie`;

const PROD_VELDEN = ["serie", "code", "naam", "stijl", "maat", "materiaal", "leverancier_code", "afbeelding", "notities"];
export async function productOpslaan(id, b, userId) {
  const v = {};
  for (const k of PROD_VELDEN) if (b[k] !== undefined) v[k] = str(b[k], k === "notities" ? 2000 : 200);
  for (const k of ["inkoop", "verkoop"]) if (b[k] !== undefined) v[`${k}_cents`] = cents(b[k]);
  if (b.moq !== undefined) v.moq = Math.max(1, int(b.moq, 50));
  if (b.actief !== undefined) v.actief = !!b.actief;
  if (!id) {
    if (!v.code || !v.naam || !v.serie) fail(400, "Vul minimaal serie, modelnummer en naam in.");
    if (await one("SELECT 1 FROM producten WHERE code = $1", [v.code])) fail(400, `Modelnummer ${v.code} bestaat al.`);
    if (!v.afbeelding) v.afbeelding = "";
  }
  const keys = Object.keys(v);
  if (!keys.length) fail(400, "Niets om op te slaan.");
  const row = id
    ? await one(`UPDATE producten SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => v[k])])
    : await one(`INSERT INTO producten (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, keys.map((k) => v[k]));
  if (!row) fail(404, "Product niet gevonden.");
  await audit(userId, id ? "product.gewijzigd" : "product.toegevoegd", { id: row.id, code: row.code });
  return row;
}

// ---------------------------------------------------------------- voorraad
export async function voorraad() {
  const rows = await q(`SELECT p.id, p.serie, p.code, p.naam, p.stijl, p.afbeelding, p.inkoop_cents, p.moq, ${STAND_SQL}
    FROM producten p ${STAND_JOIN} WHERE p.actief ORDER BY p.serie::int, p.code`);
  const tot = rows.reduce((t, r) => ({
    leverancier: t.leverancier + r.bij_leverancier, magazijn: t.magazijn + r.in_magazijn, vrij: t.vrij + Math.max(0, r.vrij_bij_leverancier),
    onderweg: t.onderweg + r.onderweg, inProductie: t.inProductie + r.in_productie,
    waardeLeverancier: t.waardeLeverancier + r.bij_leverancier * r.inkoop_cents, waardeMagazijn: t.waardeMagazijn + r.in_magazijn * r.inkoop_cents,
  }), { leverancier: 0, magazijn: 0, vrij: 0, onderweg: 0, inProductie: 0, waardeLeverancier: 0, waardeMagazijn: 0 });
  const mutaties = await q(`SELECT v.*, p.code, p.naam, p.serie, u.email AS door FROM voorraad_mutaties v JOIN producten p ON p.id = v.product_id LEFT JOIN users u ON u.id = v.user_id ORDER BY v.created_at DESC LIMIT 200`);
  return { producten: rows, totaal: tot, mutaties };
}
export async function standVan(t, productId) {
  return t.one(`SELECT COALESCE(SUM(aantal) FILTER (WHERE locatie = 'leverancier'), 0)::int AS leverancier, COALESCE(SUM(aantal) FILTER (WHERE locatie = 'magazijn'), 0)::int AS magazijn FROM voorraad_mutaties WHERE product_id = $1`, [productId]);
}
export async function mutatie(b, userId) {
  const productId = int(b.product_id), aantal = int(b.aantal);
  const locatie = b.locatie === "magazijn" ? "magazijn" : "leverancier";
  const soort = ["correctie", "beginvoorraad", "restant", "geleverd", "ontvangen"].includes(b.soort) ? b.soort : "correctie";
  if (!productId || !aantal) fail(400, "Kies een product en vul een aantal in (+ of −).");
  return tx(async (t) => {
    const p = await t.one("SELECT id, code FROM producten WHERE id = $1", [productId]);
    if (!p) fail(404, "Product niet gevonden.");
    const st = await standVan(t, productId);
    if (st[locatie] + aantal < 0) fail(400, `Er liggen maar ${st[locatie]} stuks van ${p.code} ${locatie === "magazijn" ? "in het magazijn" : "bij de leverancier"}.`);
    const row = await t.one("INSERT INTO voorraad_mutaties (product_id, locatie, aantal, soort, ref, notitie, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [productId, locatie, aantal, soort, str(b.ref, 60), str(b.notitie, 300), userId || null]);
    await audit(userId, "voorraad.mutatie", { product: p.code, locatie, aantal, soort });
    return row;
  });
}

// ---------------------------------------------------------------- klanten
const KLANT_VELDEN = ["bedrijf", "contact", "email", "telefoon", "adres", "postcode", "plaats", "land", "kvk", "btw_nummer", "notities"];
export async function klanten() {
  return q(`SELECT k.*, (SELECT COUNT(*)::int FROM orders o WHERE o.klant_id = k.id AND o.status <> 'geannuleerd') AS orders,
      (SELECT COALESCE(SUM(f.subtotaal_cents), 0)::bigint FROM facturen f WHERE f.klant_id = k.id AND f.status IN ('open','betaald')) AS omzet_cents
    FROM klanten k ORDER BY k.bedrijf`);
}
export async function klantOpslaan(id, b, userId) {
  const v = {};
  for (const k of KLANT_VELDEN) if (b[k] !== undefined) v[k] = str(b[k], k === "notities" ? 2000 : 200);
  if (v.email) v.email = v.email.toLowerCase();
  if (b.lead_id !== undefined) v.lead_id = int(b.lead_id) || null;
  if (!id && !v.bedrijf) fail(400, "Vul de naam van de zaak in.");
  const keys = Object.keys(v);
  const row = id
    ? await one(`UPDATE klanten SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => v[k])])
    : await one(`INSERT INTO klanten (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, keys.map((k) => v[k]));
  if (!row) fail(404, "Klant niet gevonden.");
  if (row.lead_id) await q("UPDATE leads SET status = 'klant', klant_id = $2, updated_at = NOW() WHERE id = $1", [row.lead_id, row.id]);
  await audit(userId, id ? "klant.gewijzigd" : "klant.toegevoegd", { id: row.id });
  return row;
}
