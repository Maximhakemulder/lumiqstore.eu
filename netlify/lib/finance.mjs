// Finance: facturen per order (PDF, per mail), openstaand/betaald/vervallen, herinneringen en cijfers per maand.
// Bedragen in centen. Prijzen in orders zijn excl. btw; de factuur rekent de btw erbij.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { q, one, tx, getSettings, str, int, cents, addDays, dayKey, datumNl, euro, fail, audit, escH, env } from "./core.mjs";
import { sendMail, brandHtml } from "./mail.mjs";

const vandaag = () => dayKey();
export const isVervallen = (f) => f.status === "open" && f.vervaldatum < vandaag();

export async function overzicht() {
  const facturen = await q(`SELECT f.*, k.bedrijf, k.email, o.nummer AS order_nummer FROM facturen f JOIN klanten k ON k.id = f.klant_id LEFT JOIN orders o ON o.id = f.order_id ORDER BY f.factuurdatum DESC, f.id DESC LIMIT 500`);
  for (const f of facturen) f.vervallen = isVervallen(f);
  const tot = await one(`SELECT
      COALESCE(SUM(totaal_cents) FILTER (WHERE status = 'open'), 0)::bigint AS openstaand,
      COALESCE(SUM(totaal_cents) FILTER (WHERE status = 'open' AND vervaldatum < CURRENT_DATE), 0)::bigint AS vervallen,
      COUNT(*) FILTER (WHERE status = 'open')::int AS open_n,
      COUNT(*) FILTER (WHERE status = 'open' AND vervaldatum < CURRENT_DATE)::int AS vervallen_n,
      COALESCE(SUM(subtotaal_cents) FILTER (WHERE status IN ('open','betaald') AND date_trunc('month', factuurdatum) = date_trunc('month', CURRENT_DATE)), 0)::bigint AS omzet_maand,
      COALESCE(SUM(subtotaal_cents) FILTER (WHERE status IN ('open','betaald') AND date_trunc('year', factuurdatum) = date_trunc('year', CURRENT_DATE)), 0)::bigint AS omzet_jaar,
      COALESCE(SUM(totaal_cents) FILTER (WHERE status = 'betaald' AND betaald_op >= date_trunc('month', CURRENT_DATE)), 0)::bigint AS ontvangen_maand
    FROM facturen`);
  // Per maand: omzet (excl. btw) tegen inkoop (besteld bij de leverancier) en marge op geleverde orders.
  const maanden = await q(`WITH m AS (SELECT to_char(date_trunc('month', CURRENT_DATE) - (i || ' months')::interval, 'YYYY-MM') AS maand FROM generate_series(0, 11) i)
    SELECT m.maand,
      (SELECT COALESCE(SUM(subtotaal_cents), 0)::bigint FROM facturen f WHERE f.status IN ('open','betaald') AND to_char(f.factuurdatum, 'YYYY-MM') = m.maand) AS omzet,
      (SELECT COALESCE(SUM(r.productie * r.prijs_cents), 0)::bigint + COALESCE((SELECT SUM(vrachtkosten_cents) FROM inkooporders i2 WHERE i2.status NOT IN ('concept','geannuleerd') AND to_char(i2.besteld_op, 'YYYY-MM') = m.maand), 0)::bigint
         FROM inkoop_regels r JOIN inkooporders i ON i.id = r.inkoop_id WHERE i.status NOT IN ('concept','geannuleerd') AND to_char(i.besteld_op, 'YYYY-MM') = m.maand) AS inkoop,
      (SELECT COALESCE(SUM(totaal_cents), 0)::bigint FROM facturen f WHERE f.status = 'betaald' AND to_char(f.betaald_op, 'YYYY-MM') = m.maand) AS ontvangen
    FROM m ORDER BY m.maand`);
  const teFactureren = await q(`SELECT o.id, o.nummer, o.status, k.bedrijf, (SELECT COALESCE(SUM(r.aantal * r.prijs_cents), 0)::bigint FROM order_regels r WHERE r.order_id = o.id) + o.verzend_cents - o.korting_cents AS subtotaal_cents
    FROM orders o JOIN klanten k ON k.id = o.klant_id WHERE o.status <> 'geannuleerd' AND NOT EXISTS (SELECT 1 FROM facturen f WHERE f.order_id = o.id AND f.status <> 'gecrediteerd') ORDER BY o.besteld_op`);
  return { facturen, totaal: tot, maanden, teFactureren };
}

// Factuur maken van een order (of los met regels).
export async function factuurMaken(b, userId) {
  const s = await getSettings();
  return tx(async (t) => {
    let klantId = int(b.klant_id), orderId = int(b.order_id) || null, regels = [];
    if (orderId) {
      const o = await t.one("SELECT * FROM orders WHERE id = $1", [orderId]);
      if (!o) fail(404, "Order niet gevonden.");
      if (await t.one("SELECT 1 FROM facturen WHERE order_id = $1 AND status <> 'gecrediteerd'", [orderId])) fail(400, "Deze order heeft al een factuur.");
      klantId = o.klant_id;
      regels = (await t.q("SELECT omschrijving, aantal, prijs_cents FROM order_regels WHERE order_id = $1 ORDER BY id", [orderId])).map((r) => ({ omschrijving: r.omschrijving, aantal: r.aantal, prijs_cents: r.prijs_cents }));
      if (o.verzend_cents) regels.push({ omschrijving: "Verzending", aantal: 1, prijs_cents: o.verzend_cents });
      if (o.korting_cents) regels.push({ omschrijving: "Korting", aantal: 1, prijs_cents: -o.korting_cents });
      b.omschrijving = b.omschrijving || `Order ${o.nummer}${o.referentie ? ` (${o.referentie})` : ""}`;
    } else {
      regels = (Array.isArray(b.regels) ? b.regels : []).map((r) => ({ omschrijving: str(r.omschrijving, 200), aantal: int(r.aantal, 1), prijs_cents: cents(r.prijs) })).filter((r) => r.omschrijving && r.aantal);
      if (!regels.length) fail(400, "Voeg minimaal één regel toe.");
    }
    if (!klantId || !(await t.one("SELECT 1 FROM klanten WHERE id = $1", [klantId]))) fail(400, "Kies een klant.");
    const pct = Number(b.btw_pct ?? s.finance.vatRate ?? 21);
    const sub = regels.reduce((x, r) => x + r.aantal * r.prijs_cents, 0);
    const btw = Math.round((sub * pct) / 100);
    const n = (await t.one("SELECT nextval('factuur_nummer_seq') AS n")).n;
    const nummer = `${s.finance.invoicePrefix || "LQ"}-${vandaag().slice(0, 4)}-${String(n).padStart(4, "0")}`;
    const datum = str(b.factuurdatum, 10) || vandaag();
    const f = await t.one(`INSERT INTO facturen (nummer, klant_id, order_id, factuurdatum, vervaldatum, omschrijving, regels, subtotaal_cents, btw_pct, btw_cents, totaal_cents, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'open') RETURNING *`,
      [nummer, klantId, orderId, datum, addDays(datum, int(s.finance.paymentTermDays, 14)), str(b.omschrijving, 200), JSON.stringify(regels), sub, pct, btw, sub + btw]);
    await audit(userId, "factuur.gemaakt", { id: f.id, nummer });
    return f;
  });
}

export async function factuurActie(id, b, userId) {
  const f = await one("SELECT f.*, k.email, k.bedrijf, k.contact FROM facturen f JOIN klanten k ON k.id = f.klant_id WHERE f.id = $1", [id]);
  if (!f) fail(404, "Factuur niet gevonden.");
  const actie = String(b.actie || "");
  if (actie === "betaald") { await q("UPDATE facturen SET status = 'betaald', betaald_op = $2, updated_at = NOW() WHERE id = $1", [id, str(b.datum, 10) || vandaag()]); }
  else if (actie === "open") { await q("UPDATE facturen SET status = 'open', betaald_op = NULL, updated_at = NOW() WHERE id = $1", [id]); }
  else if (actie === "crediteer") {
    if (f.status === "gecrediteerd") fail(400, "Deze factuur is al gecrediteerd.");
    await q("UPDATE facturen SET status = 'gecrediteerd', updated_at = NOW() WHERE id = $1", [id]);
  } else if (actie === "verstuur" || actie === "herinnering") {
    if (!f.email) fail(400, "De klant heeft geen e-mailadres. Vul het in bij de klant.");
    const r = await mailFactuur(f, actie === "herinnering");
    if (!r.ok) fail(502, r.error || "Versturen lukte niet.");
  } else fail(400, "Onbekende actie.");
  await audit(userId, `factuur.${actie}`, { id, nummer: f.nummer });
  return one("SELECT * FROM facturen WHERE id = $1", [id]);
}

async function mailFactuur(f, herinnering = false) {
  const s = await getSettings(), co = s.company;
  const pdf = await factuurPdf(f.id);
  const naam = (f.contact || "").split(/\s+/)[0] || "";
  const zin = herinnering
    ? `Volgens onze administratie staat factuur ${f.nummer} van ${datumNl(f.factuurdatum)} (${euro(f.totaal_cents)}) nog open. De vervaldatum was ${datumNl(f.vervaldatum)}. Wil je het bedrag overmaken? Is het al betaald, dan kun je deze mail negeren.`
    : `In de bijlage vind je factuur ${f.nummer} van ${euro(f.totaal_cents)} (incl. btw). We vragen je het bedrag vóór ${datumNl(f.vervaldatum)} over te maken.`;
  const betaal = co.iban ? `IBAN ${co.iban} t.n.v. ${co.legalName || co.name}, o.v.v. ${f.nummer}.` : `Vermeld bij betaling ${f.nummer}.`;
  const res = await sendMail({
    to: f.email, kind: herinnering ? "factuur-herinnering" : "factuur", ref: `factuur:${f.id}`, replyTo: co.email,
    subject: herinnering ? `Herinnering: factuur ${f.nummer}` : `Factuur ${f.nummer} van Lumiq`,
    text: `Hoi${naam ? " " + naam : ""},\n\n${zin}\n\n${betaal}\n\nVragen? Reageer gewoon op deze mail.\n\nGroet,\nLumiq\n${co.phone}`,
    html: brandHtml({ title: herinnering ? "Herinnering: factuur staat nog open" : `Factuur ${f.nummer}`, intro: [`Hoi${naam ? " " + escH(naam) : ""},`, escH(zin), escH(betaal)], after: ["Vragen? Reageer gewoon op deze mail."], footnote: `${co.legalName || co.name} · KvK ${co.kvk}${co.vat ? " · btw " + co.vat : ""}` }),
    attachments: [{ filename: `${f.nummer}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }],
  });
  if (res.ok) {
    if (herinnering) await q("UPDATE facturen SET herinnering_at = NOW(), herinneringen = herinneringen + 1, updated_at = NOW() WHERE id = $1", [f.id]);
    else await q("UPDATE facturen SET verzonden_at = NOW(), updated_at = NOW() WHERE id = $1", [f.id]);
  }
  return res;
}

// Elke dag (via tick): herinnering voor open facturen die reminderDays over de vervaldatum zijn, maximaal 2 keer.
export async function runHerinneringen({ max = 3 } = {}) {
  const s = await getSettings();
  if (!s.finance.autoReminders) return { uit: true };
  const dagen = String(int(s.finance.reminderDays, 7));
  const rows = await q(`SELECT f.*, k.email, k.bedrijf, k.contact FROM facturen f JOIN klanten k ON k.id = f.klant_id
    WHERE f.status = 'open' AND f.verzonden_at IS NOT NULL AND k.email <> '' AND f.herinneringen < 2
      AND f.vervaldatum + ($1 || ' days')::interval < NOW() AND (f.herinnering_at IS NULL OR f.herinnering_at < NOW() - ($1 || ' days')::interval)
    ORDER BY f.vervaldatum LIMIT $2`, [dagen, max]);
  let n = 0;
  for (const f of rows) if ((await mailFactuur(f, true)).ok) n++;
  return { verstuurd: n };
}

// ---------------------------------------------------------------- PDF
export async function factuurPdf(id) {
  const f = await one("SELECT f.*, k.* , f.id AS fid FROM facturen f JOIN klanten k ON k.id = f.klant_id WHERE f.id = $1", [id]);
  if (!f) fail(404, "Factuur niet gevonden.");
  const s = await getSettings(), co = s.company;
  const doc = await PDFDocument.create();
  doc.setTitle(`Factuur ${f.nummer}`); doc.setAuthor(co.legalName || co.name);
  const page = doc.addPage([595.28, 841.89]);
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.086, 0.07), muted = rgb(0.44, 0.4, 0.35), goud = rgb(0.79, 0.63, 0.36);
  const W = 595.28, L = 50, R = W - 50;
  const tekst = (t, x, y, { size = 10, font = reg, color = ink, align = "left" } = {}) => {
    const v = String(t ?? "").replace(/[^\x20-\x7E -ÿ€–—‘’“”•]/g, "");
    const w = font.widthOfTextAtSize(v, size);
    page.drawText(v, { x: align === "right" ? x - w : x, y, size, font, color });
  };
  page.drawRectangle({ x: 0, y: 841.89 - 90, width: W, height: 90, color: rgb(0.1, 0.086, 0.07) });
  tekst("LUMIQ", L, 841.89 - 52, { size: 26, font: bold, color: goud });
  tekst("Draadloze tafellampen voor de horeca", L, 841.89 - 70, { size: 9, color: rgb(0.85, 0.8, 0.72) });
  tekst("FACTUUR", R, 841.89 - 52, { size: 20, font: bold, color: rgb(1, 1, 1), align: "right" });
  let y = 841.89 - 130;
  // Afzender rechts, klant links.
  const afz = [co.legalName || co.name, co.address, [co.postcode, co.city].filter(Boolean).join(" "), co.email, co.phone, co.kvk ? `KvK ${co.kvk}` : "", co.vat ? `Btw ${co.vat}` : "", co.iban ? `IBAN ${co.iban}` : ""].filter(Boolean);
  afz.forEach((r, i) => tekst(r, R, y - i * 13, { size: 9, color: muted, align: "right" }));
  tekst("Factuur aan", L, y, { size: 8, color: muted });
  [f.bedrijf, f.contact ? `t.a.v. ${f.contact}` : "", f.adres, [f.postcode, f.plaats].filter(Boolean).join(" "), f.land && f.land !== "Nederland" ? f.land : "", f.btw_nummer ? `Btw ${f.btw_nummer}` : ""].filter(Boolean)
    .forEach((r, i) => tekst(r, L, y - 14 - i * 13, { size: i === 0 ? 11 : 10, font: i === 0 ? bold : reg }));
  y -= 130;
  const meta = [["Factuurnummer", f.nummer], ["Factuurdatum", datumNl(f.factuurdatum)], ["Vervaldatum", datumNl(f.vervaldatum)], f.omschrijving ? ["Betreft", f.omschrijving] : null].filter(Boolean);
  meta.forEach(([k, v], i) => { tekst(k, L, y - i * 15, { size: 9, color: muted }); tekst(v, L + 95, y - i * 15, { size: 10, font: i === 0 ? bold : reg }); });
  y -= meta.length * 15 + 22;
  // Tabel
  const cols = { oms: L, aantal: 360, prijs: 450, tot: R };
  page.drawRectangle({ x: L - 6, y: y - 6, width: R - L + 12, height: 22, color: rgb(0.95, 0.93, 0.9) });
  tekst("Omschrijving", cols.oms, y, { size: 9, font: bold }); tekst("Aantal", cols.aantal, y, { size: 9, font: bold, align: "right" });
  tekst("Prijs", cols.prijs, y, { size: 9, font: bold, align: "right" }); tekst("Totaal", cols.tot, y, { size: 9, font: bold, align: "right" });
  y -= 24;
  const regels = Array.isArray(f.regels) ? f.regels : [];
  for (const r of regels) {
    if (y < 170) break;
    let oms = String(r.omschrijving || "");
    while (reg.widthOfTextAtSize(oms, 10) > 290 && oms.length > 4) oms = oms.slice(0, -2);
    if (oms !== String(r.omschrijving || "")) oms = oms.trimEnd() + "…";
    tekst(oms, cols.oms, y); tekst(String(r.aantal), cols.aantal, y, { align: "right" });
    tekst(euro(r.prijs_cents), cols.prijs, y, { align: "right" }); tekst(euro(r.aantal * r.prijs_cents), cols.tot, y, { align: "right" });
    y -= 17;
  }
  y -= 6; page.drawLine({ start: { x: 330, y: y + 8 }, end: { x: R, y: y + 8 }, thickness: 0.6, color: rgb(0.8, 0.77, 0.72) });
  const som = [["Subtotaal (excl. btw)", euro(f.subtotaal_cents)], [`Btw ${String(f.btw_pct).replace(".", ",")}%`, euro(f.btw_cents)]];
  som.forEach(([k, v]) => { tekst(k, 450, y - 4, { size: 10, color: muted, align: "right" }); tekst(v, R, y - 4, { align: "right" }); y -= 16; });
  page.drawRectangle({ x: 330, y: y - 12, width: R - 330 + 6, height: 24, color: rgb(0.1, 0.086, 0.07) });
  tekst("Totaal", 340, y - 4, { size: 11, font: bold, color: rgb(1, 1, 1) }); tekst(euro(f.totaal_cents), R - 2, y - 4, { size: 11, font: bold, color: goud, align: "right" });
  y -= 50;
  const betaal = co.iban ? `Graag het totaalbedrag vóór ${datumNl(f.vervaldatum)} overmaken op ${co.iban} t.n.v. ${co.legalName || co.name}, o.v.v. ${f.nummer}.`
    : `Graag het totaalbedrag vóór ${datumNl(f.vervaldatum)} overmaken, o.v.v. ${f.nummer}.`;
  tekst(betaal, L, y, { size: 9, color: muted });
  if (f.status === "betaald") tekst(`Betaald op ${datumNl(f.betaald_op)} — dank je wel!`, L, y - 16, { size: 10, font: bold, color: rgb(0.15, 0.5, 0.25) });
  if (f.status === "gecrediteerd") tekst("Deze factuur is gecrediteerd.", L, y - 16, { size: 10, font: bold, color: rgb(0.7, 0.2, 0.15) });
  tekst(`${co.name} · ${String(co.website || "").replace(/^https?:\/\//, "")} · ${co.email} · ${co.phone}`, L, 30, { size: 8, color: muted });
  return doc.save();
}
export const _test = { env };
