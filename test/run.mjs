// Integratietest van de hele keten tegen een lokale Postgres. Start: npm test
// Er gaan geen echte mails de deur uit (capture-mail).
import assert from "node:assert/strict";
import { NetlifyDB } from "@netlify/database-dev";

const db = new NetlifyDB();
const cs = await db.start();
await db.applyMigrations("./netlify/database/migrations");
Object.assign(process.env, {
  LQ_DB_URL: cs, MAIL_TRANSPORT: "capture", LQ_INSECURE_COOKIE: "1", ADMIN_EMAILS: "maxim@lumiq.test", HQ_ALLEEN: "maxim@lumiq.test,sam@lumiq.test",
  AUTH_SECRET: "test-secret", PUBLIC_BASE_URL: "https://lumiq.test", B2B_ANY_TIME: "1", AI_FAKE: "1",
});
globalThis.__aiFake = () => '{"intro":"Een terras aan het water, daar wil je blijven zitten.","notitie":"restaurant met terras"}';
const { default: api } = await import("../netlify/functions/api.mjs");
const { captured } = await import("../netlify/lib/mail.mjs");
const { sendBatch, recordTrack } = await import("../netlify/lib/b2b.mjs");
const { q, one, closeDb } = await import("../netlify/lib/core.mjs");

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name); throw e; } };
async function call(method, p, { body, cookie, csrf = true, form } = {}) {
  const h = {}; if (cookie) h.cookie = cookie; if (csrf && method !== "GET") h["x-lq"] = "1";
  let b; if (form) { b = new URLSearchParams(form); h["content-type"] = "application/x-www-form-urlencoded"; h.origin = "https://lumiq.test"; }
  else if (body !== undefined) { b = JSON.stringify(body); h["content-type"] = "application/json"; }
  const res = await api(new Request("https://lumiq.test/api/" + p, { method, headers: h, body: b, redirect: "manual" }), { ip: "10.0.0.1" });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : ct.includes("pdf") ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return { status: res.status, data, cookie: res.headers.get("set-cookie"), location: res.headers.get("location") };
}
const lastCode = (to) => { const m = [...captured].reverse().find((x) => x.to === to && /inlogcode/i.test(x.subject)); return m && m.subject.match(/(\d{6})/)[1]; };

console.log("Website");
await test("catalogus aanvragen: validatie", async () => {
  const r = await call("POST", "catalogus", { body: { naam: "", zaak: "", email: "x" } });
  assert.equal(r.status, 400); assert.ok(r.data.errors.naam && r.data.errors.bedrijf && r.data.errors.email);
});
let token;
await test("catalogus aanvragen: aanvraag, mail met link en melding", async () => {
  const r = await call("POST", "catalogus", { body: { naam: "Sanne de Vries", zaak: "Brasserie Haven", email: "info@brasseriehaven.test", telefoon: "0612345678", tafels: "20 – 50", demo: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); token = r.data.token; assert.ok(r.data.download.includes("/api/catalogus/download?t="));
  assert.ok(captured.some((m) => m.to === "info@brasseriehaven.test" && /catalogus/i.test(m.subject) && m.text.includes(token)));
  assert.ok(captured.some((m) => /Demo \+ catalogus: Brasserie Haven/.test(m.subject)));
});
await test("download telt mee en stuurt door naar de PDF", async () => {
  const r = await call("GET", "catalogus/download?t=" + encodeURIComponent(token));
  assert.equal(r.status, 302); assert.match(r.location, /lumiq-catalogus\.pdf$/);
  const a = await one("SELECT downloads FROM aanvragen WHERE token = $1", [token]); assert.equal(a.downloads, 1);
});
await test("formulier zonder JavaScript: redirect naar bedankpagina", async () => {
  const r = await call("POST", "catalogus", { csrf: false, form: { "form-name": "catalogus", Naam: "Piet", Zaak: "Hotel Zee", "E-mail": "info@hotelzee.test", Tafels: "50 – 100" } });
  assert.equal(r.status, 303); assert.match(r.location, /catalogus-bedankt\.html\?t=/);
});
await test("offerte aanvragen", async () => {
  const r = await call("POST", "offerte", { body: { Voornaam: "Jan", Achternaam: "Bakker", "E-mail": "jan@cafe.test", Zaak: "Café Jan", Aantal: "40", Interesse: "Demo in mijn zaak" } });
  assert.equal(r.status, 200); assert.ok(captured.some((m) => m.to === "jan@cafe.test" && /ontvangen/.test(m.subject)));
});
await test("zonder x-lq header geen JSON-post (CSRF)", async () => {
  const r = await call("POST", "catalogus", { csrf: false, body: { naam: "a", zaak: "b", email: "a@b.test" } }); assert.equal(r.status, 403);
});

console.log("Inloggen");
let cookie;
await test("onbekend adres krijgt geen code", async () => {
  const before = captured.length; const r = await call("POST", "auth/code", { body: { email: "hacker@evil.test" } });
  assert.equal(r.status, 200); assert.equal(captured.length, before);
});
await test("Maxim logt in met code", async () => {
  await call("POST", "auth/code", { body: { email: "maxim@lumiq.test" } });
  const v = await call("POST", "auth/verify", { body: { email: "maxim@lumiq.test", code: lastCode("maxim@lumiq.test") } });
  assert.equal(v.status, 200, JSON.stringify(v.data)); cookie = v.cookie.split(";")[0];
  const me = await call("GET", "auth/me", { cookie }); assert.equal(me.data.user.role, "admin");
});
await test("HQ zonder sessie: 401", async () => { assert.equal((await call("GET", "hq/overzicht")).status, 401); });

console.log("B2B");
let leadId;
await test("lead toevoegen, goedkeuren en mailen met catalogus", async () => {
  const r = await call("POST", "hq/leads", { cookie, body: { company: "Restaurant De Kade", email: "info@dekade.test", city: "Rotterdam", category: "restaurant" } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); leadId = r.data.lead.id;
  await call("POST", "hq/leads/actie", { cookie, body: { ids: [leadId], actie: "goedkeuren" } });
  const res = await sendBatch({ max: 5 }); assert.equal(res.sent, 1, JSON.stringify(res));
  const m = captured.find((x) => x.to === "info@dekade.test");
  assert.match(m.subject, /De Kade/); assert.ok(m.text.includes("/brochure/lumiq-catalogus.pdf")); assert.ok(m.html.includes("Bekijk de catalogus")); assert.ok(m.html.includes("/api/t/k?"));
  assert.ok(m.text.includes("afmelden"));
});
await test("klik op catalogus in mail → interesse + melding", async () => {
  await q("UPDATE mail_log SET created_at = NOW() - INTERVAL '5 minutes' WHERE ref = $1", [`lead:${leadId}`]);
  const u = Buffer.from("https://lumiq.test/brochure/lumiq-catalogus.pdf").toString("base64url");
  assert.ok(await recordTrack({ l: leadId, m: "eerste", u, ua: "Mozilla/5.0" }));
  const l = await one("SELECT status, catalogus_at FROM leads WHERE id = $1", [leadId]); assert.equal(l.status, "interesse"); assert.ok(l.catalogus_at);
  assert.ok(captured.some((x) => /Catalogus geopend: Restaurant De Kade/.test(x.subject)));
});
await test("B2B-dashboard en aanvragen laden", async () => {
  const d = await call("GET", "hq/b2b", { cookie }); assert.equal(d.status, 200, JSON.stringify(d.data)); assert.equal(d.data.mail.alles.catalogus, 1);
  const a = await call("GET", "hq/aanvragen", { cookie }); assert.equal(a.status, 200); assert.equal(a.data.stats.catalogus, 2); assert.equal(a.data.stats.viaMail, 1);
  const l = await call("GET", "hq/leads?status=warm", { cookie }); assert.equal(l.data.leads.length, 1);
  const lead = await call("GET", "hq/lead/" + leadId, { cookie }); assert.equal(lead.status, 200); assert.ok(lead.data.voorbeeld.eerste.body.includes("catalogus"));
});

console.log("Producten, orders, inkoop en voorraad");
let p701, p101, klantId, orderId, poId;
await test("64 modellen staan erin; prijs invullen", async () => {
  const r = await call("GET", "hq/producten", { cookie }); assert.equal(r.data.producten.length, 64);
  p701 = r.data.producten.find((p) => p.code === "701"); p101 = r.data.producten.find((p) => p.code === "101");
  assert.equal(p701.leverancier_code, "14T8");
  const u = await call("POST", "hq/product/" + p701.id, { cookie, body: { inkoop: "18,50", verkoop: "79,95" } });
  assert.equal(u.data.product.inkoop_cents, 1850); assert.equal(u.data.product.verkoop_cents, 7995);
});
await test("nieuw product aanmaken", async () => {
  const r = await call("POST", "hq/producten", { cookie, body: { serie: "1300", code: "1301", naam: "Testlamp", stijl: "Nieuw", moq: 50 } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.product.code, "1301");
  assert.equal((await call("POST", "hq/producten", { cookie, body: { serie: "1300", code: "1301", naam: "x" } })).status, 400);
});
await test("order van 30 maken (nieuwe klant)", async () => {
  const r = await call("POST", "hq/orders", { cookie, body: { klant: { bedrijf: "Restaurant De Kade", email: "info@dekade.test", contact: "Kees", plaats: "Rotterdam", lead_id: leadId },
    regels: [{ product_id: p701.id, aantal: 30 }, { omschrijving: "Laadtrolley 24 stuks", aantal: 1, prijs: "399" }], verzend: "25" } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); orderId = r.data.order.id; klantId = r.data.order.klant_id;
  const o = await call("GET", "hq/order/" + orderId, { cookie });
  assert.equal(Number(o.data.order.subtotaal_cents), 30 * 7995 + 39900 + 2500);
  assert.equal((await one("SELECT status FROM leads WHERE id = $1", [leadId])).status, "klant");
});
await test("inkoop: behoefte 30 → produceer 50 (MOQ), 20 blijven bij de leverancier", async () => {
  const r = await call("GET", "hq/inkoop", { cookie }); const x = r.data.behoefte.find((b) => b.code === "701");
  assert.equal(x.nodig, 30); assert.equal(x.productie, 50); assert.equal(x.overschot, 20);
  const po = await call("POST", "hq/inkoop/behoefte", { cookie, body: {} }); assert.equal(po.status, 200, JSON.stringify(po.data)); poId = po.data.inkoop.id;
  const d = await call("GET", "hq/inkoop/" + poId, { cookie }); assert.equal(d.data.regels[0].productie, 50); assert.equal(d.data.regels[0].verzenden, 30); assert.equal(d.data.regels[0].blijft, 20);
  assert.match(d.data.bestellijst, /14T8 .* produce 50.*ship 30.*keep in stock 20/);
});
await test("bestellen: levertijd 21 + 7 dagen; order in productie", async () => {
  const r = await call("POST", `hq/inkoop/${poId}/status`, { cookie, body: { status: "besteld", datum: "2026-11-02" } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.inkoop.klaar_verwacht, "2026-11-23"); assert.equal(r.data.inkoop.binnen_verwacht, "2026-11-30");
  const o = await one("SELECT status, leverdatum FROM orders WHERE id = $1", [orderId]); assert.equal(o.status, "in_productie"); assert.equal(o.leverdatum, "2026-11-30");
});
await test("verzonden: 20 stuks blijven als voorraad bij de leverancier", async () => {
  const r = await call("POST", `hq/inkoop/${poId}/status`, { cookie, body: { status: "verzonden", datum: "2026-11-23" } }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = await call("GET", "hq/voorraad", { cookie }); const p = v.data.producten.find((x) => x.code === "701");
  assert.equal(p.bij_leverancier, 20); assert.equal(p.onderweg, 30); assert.equal(p.in_magazijn, 0);
  assert.equal((await one("SELECT status FROM orders WHERE id = $1", [orderId])).status, "onderweg");
});
await test("ontvangen en leveren: magazijn op en weer af", async () => {
  await call("POST", `hq/inkoop/${poId}/status`, { cookie, body: { status: "ontvangen" } });
  assert.equal((await one("SELECT status FROM orders WHERE id = $1", [orderId])).status, "binnen");
  const r = await call("POST", "hq/order/" + orderId, { cookie, body: { status: "geleverd" } }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = await call("GET", "hq/voorraad", { cookie }); const p = v.data.producten.find((x) => x.code === "701");
  assert.equal(p.in_magazijn, 0); assert.equal(p.bij_leverancier, 20);
});
await test("volgende order van 15 komt uit de voorraad bij de leverancier (geen productie)", async () => {
  const r = await call("POST", "hq/orders", { cookie, body: { klant_id: klantId, regels: [{ product_id: p701.id, aantal: 15 }] } }); assert.equal(r.status, 200);
  const b = (await call("GET", "hq/inkoop", { cookie })).data.behoefte.find((x) => x.code === "701");
  assert.equal(b.uit_voorraad, 15); assert.equal(b.productie, 0);
  const po = await call("POST", "hq/inkoop/behoefte", { cookie, body: {} });
  const st = await call("POST", `hq/inkoop/${po.data.inkoop.id}/status`, { cookie, body: { status: "besteld", datum: "2026-12-01" } });
  assert.equal(st.data.inkoop.binnen_verwacht, "2026-12-08"); // alleen luchtvracht
  const v = (await call("GET", "hq/voorraad", { cookie })).data.producten.find((x) => x.code === "701");
  assert.equal(v.gereserveerd, 15); assert.equal(v.vrij_bij_leverancier, 5);
});
await test("MOQ wordt bewaakt bij handmatige inkoop", async () => {
  const r = await call("POST", "hq/inkoop", { cookie, body: { regels: [{ product_id: p101.id, productie: 20 }] } }); assert.equal(r.status, 400); assert.match(r.data.error, /MOQ/);
  const ok = await call("POST", "hq/inkoop", { cookie, body: { regels: [{ product_id: p101.id, productie: 50, verzenden: 10 }] } }); assert.equal(ok.status, 200, JSON.stringify(ok.data));
});
await test("voorraadcorrectie kan niet onder nul", async () => {
  assert.equal((await call("POST", "hq/voorraad/mutatie", { cookie, body: { product_id: p101.id, locatie: "magazijn", aantal: -5 } })).status, 400);
  assert.equal((await call("POST", "hq/voorraad/mutatie", { cookie, body: { product_id: p101.id, locatie: "magazijn", aantal: 12, soort: "beginvoorraad" } })).status, 200);
});

console.log("Finance");
let factuurId;
await test("factuur van order: 21% btw, nummer, PDF", async () => {
  const r = await call("POST", "hq/facturen", { cookie, body: { order_id: orderId } }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.factuur; factuurId = f.id;
  const sub = 30 * 7995 + 39900 + 2500; assert.equal(f.subtotaal_cents, sub); assert.equal(f.btw_cents, Math.round(sub * 0.21)); assert.match(f.nummer, /^LQ-\d{4}-0001$/);
  assert.equal((await call("POST", "hq/facturen", { cookie, body: { order_id: orderId } })).status, 400);
  const pdf = await call("GET", `hq/factuur/${f.id}/pdf`, { cookie }); assert.equal(pdf.status, 200); assert.equal(pdf.data.subarray(0, 4).toString(), "%PDF");
});
await test("factuur versturen (met PDF) en betaald zetten", async () => {
  const r = await call("POST", `hq/factuur/${factuurId}`, { cookie, body: { actie: "verstuur" } }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = captured.find((x) => /Factuur LQ-/.test(x.subject)); assert.ok(m.attachments?.[0]?.filename.endsWith(".pdf"));
  await call("POST", `hq/factuur/${factuurId}`, { cookie, body: { actie: "betaald" } });
  const fo = await call("GET", "hq/finance", { cookie }); assert.equal(fo.status, 200); assert.equal(Number(fo.data.totaal.openstaand), 0);
});
await test("herinnering voor vervallen factuur", async () => {
  const f = await call("POST", "hq/facturen", { cookie, body: { klant_id: klantId, regels: [{ omschrijving: "Extra lader", aantal: 1, prijs: "59,95" }] } });
  await call("POST", `hq/factuur/${f.data.factuur.id}`, { cookie, body: { actie: "verstuur" } });
  await q("UPDATE facturen SET vervaldatum = CURRENT_DATE - 10 WHERE id = $1", [f.data.factuur.id]);
  const { runHerinneringen } = await import("../netlify/lib/finance.mjs");
  assert.equal((await runHerinneringen()).verstuurd, 1);
  assert.ok(captured.some((m) => /Herinnering: factuur/.test(m.subject)));
});

console.log("Overzicht en instellingen");
await test("overzicht laadt", async () => { const r = await call("GET", "hq/overzicht", { cookie }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(Array.isArray(r.data.wacht)); });
await test("instellingen opslaan (alleen beheerder)", async () => {
  const r = await call("POST", "hq/instellingen", { cookie, body: { sleutel: "company", waarde: { iban: "NL00BANK0123456789" } } }); assert.equal(r.status, 200);
  assert.equal(r.data.instellingen.company.iban, "NL00BANK0123456789"); assert.equal(r.data.instellingen.company.kvk, "86560875");
});
await test("afmelden via link", async () => {
  const { unsubUrl } = await import("../netlify/lib/b2b.mjs");
  const u = new URL(unsubUrl(leadId)); const r = await call("GET", "b2b/afmelden" + u.search); assert.equal(r.status, 200); assert.match(r.data, /afgemeld/);
  assert.ok(await one("SELECT 1 FROM suppressions WHERE email = 'info@dekade.test'"));
});

await test("vaste HQ-code: geen mail, wel inloggen", async () => {
  process.env.HQ_CODE = "246810"; const voor = captured.length;
  const r = await call("POST", "auth/code", { body: { email: "sam@lumiq.test" } }); assert.equal(r.data.vast, true); assert.equal(captured.length, voor);
  assert.equal((await call("POST", "auth/verify", { body: { email: "sam@lumiq.test", code: "111111" } })).status, 400);
  await call("POST", "auth/code", { body: { email: "sam@lumiq.test" } });
  const v = await call("POST", "auth/verify", { body: { email: "sam@lumiq.test", code: "246810" } }); assert.equal(v.status, 200, JSON.stringify(v.data));
  await call("POST", "auth/code", { body: { email: "hacker@evil.test" } });
  assert.notEqual((await call("POST", "auth/verify", { body: { email: "hacker@evil.test", code: "246810" } })).status, 200);
  const alleen = await call("POST", "auth/verify", { body: { code: "246810" } }); assert.equal(alleen.status, 200, JSON.stringify(alleen.data)); assert.equal(alleen.data.user.email, "maxim@lumiq.test");
  assert.equal((await call("POST", "auth/verify", { body: { code: "000000" } })).status, 400);
  assert.equal((await call("GET", "auth/me")).data.vast, true);
  delete process.env.HQ_CODE;
});

console.log("Research");
await test("mailadressen vinden: verstopt, Cloudflare, persoonlijk en gmail", async () => {
  const { _research: R } = await import("../netlify/lib/b2b.mjs");
  const cf = (e) => { const k = 0x42; return k.toString(16).padStart(2, "0") + [...e].map((c) => (c.charCodeAt(0) ^ k).toString(16).padStart(2, "0")).join(""); };
  assert.equal(R.cfDecode(cf("info@zino.nl")), "info@zino.nl");
  const html = `<a href="/cdn-cgi/l/email-protection#${cf("reserveren@zino.nl")}">mail</a> Mail ons: sanne [at] zino [dot] nl <a href="mailto:hallo%40zino.nl">x</a>`;
  const e = R.findEmails(html, "", "zino.nl");
  assert.ok(e.includes("reserveren@zino.nl") && e.includes("sanne@zino.nl") && e.includes("hallo@zino.nl"), JSON.stringify(e));
  assert.ok(["reserveren@zino.nl", "hallo@zino.nl"].includes(R.kiesEmail(e, "zino.nl")));
  assert.equal(R.kiesEmail(["sanne@zino.nl"], "zino.nl"), "sanne@zino.nl");
  assert.equal(R.kiesEmail(["bistrozino@gmail.com"], "zino.nl"), "bistrozino@gmail.com");
  assert.equal(R.kiesEmail(["sanne@zino.nl", "info@zino.nl"], "zino.nl"), "info@zino.nl");
  assert.equal(R.kiesEmail(["sanne@zinogroep.nl"], "zino.nl"), "sanne@zinogroep.nl");
});

console.log("Team");
await test("team: kaarten, vraag aan een afdeling, briefing en taken", async () => {
  globalThis.__aiFake = ({ prompt }) => prompt.includes("ochtendbriefing") ? '{"samenvatting":"Rustige start.","afdelingen":[{"afdeling":"b2b","tekst":"Twee leads warm."}],"taken":[{"wie":"Armand","afdeling":"b2b","tekst":"Bel Restaurant De Kade"}]}' : "- Bel Restaurant De Kade";
  const t = await call("GET", "hq/team", { cookie }); assert.equal(t.status, 200, JSON.stringify(t.data)); assert.equal(t.data.afdelingen.length, 6); assert.ok(t.data.kaarten.b2b.length === 3);
  const v = await call("POST", "hq/team/vraag", { cookie, body: { afdeling: "b2b", vraag: "Wie moet ik bellen?", door: "Armand" } });
  assert.equal(v.status, 200, JSON.stringify(v.data)); assert.equal(v.data.vraag.status, "klaar"); assert.match(v.data.vraag.antwoord, /De Kade/);
  for (const k of ["directie", "b2b", "aanvragen", "inkoop", "orders", "finance"]) { const { stand } = await import("../netlify/lib/team.mjs"); assert.ok(await stand(k)); }
  const br = await call("POST", "hq/team/briefing", { cookie, body: {} }); assert.equal(br.status, 200, JSON.stringify(br.data)); assert.equal(br.data.briefing.inhoud.samenvatting, "Rustige start.");
  const tk = await call("GET", "hq/taken", { cookie }); const bt = tk.data.taken.find((x) => x.bron === "briefing"); assert.ok(bt && bt.wie === "Armand");
  await call("POST", "hq/taken", { cookie, body: { dag: tk.data.dag, taak_id: bt.id, gedaan: true, door: "Armand" } });
  assert.ok((await call("GET", "hq/taken", { cookie })).data.taken.find((x) => x.id === bt.id).gedaan);
  const o = await call("GET", "hq/overzicht", { cookie }); assert.equal(o.data.briefing.inhoud.samenvatting, "Rustige start.");
});
await test("briefing zonder AI: uit de cijfers", async () => {
  const { maakBriefing, briefing } = await import("../netlify/lib/team.mjs");
  delete process.env.AI_FAKE; await maakBriefing({ force: true }); process.env.AI_FAKE = "1";
  const b = await briefing(); assert.equal(b.bron, "cijfers"); assert.ok(b.inhoud.samenvatting.length > 10);
});

console.log(`\n${passed} tests geslaagd.`);
await closeDb(); await db.stop?.(); process.exit(0);
