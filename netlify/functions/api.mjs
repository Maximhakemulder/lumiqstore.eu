// Eén API voor de Lumiq-website (catalogus, offerte, meten) en Lumiq HQ.
import { json, HttpError, fail, escH, publicBase, getSettings, saveSetting, DEFAULT_SETTINGS, q, one, int, str, audit, HORECA, PLAATSEN } from "../lib/core.mjs";
import { mailReady, b2bApart, mailEnv } from "../lib/mail.mjs";
import * as team from "../lib/team.mjs";
import { requestCode, verifyCode, verifyVast, vasteCode, currentUser, logout, ipOf, requireStaff, requireAdmin } from "../lib/auth.mjs";
import * as b2b from "../lib/b2b.mjs";
import { b2bDashboard } from "../lib/b2bstats.mjs";
import * as cat from "../lib/catalogus.mjs";
import * as vr from "../lib/voorraad.mjs";
import * as handel from "../lib/handel.mjs";
import * as fin from "../lib/finance.mjs";
import { overzicht } from "../lib/overzicht.mjs";

async function lees(req) {
  const ct = req.headers.get("content-type") || "";
  try {
    if (/json/.test(ct)) return await req.json();
    if (/form-urlencoded|multipart/.test(ct)) { const f = await req.formData(); return Object.fromEntries([...f.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""])); }
    return JSON.parse((await req.text()) || "{}");
  } catch { return {}; }
}
// Wijzigende verzoeken alleen vanaf onze eigen pagina's (CSRF): header x-lq of een formulier van dezelfde host.
function eigenOrigin(req) {
  const origin = req.headers.get("origin");
  let zelfde = true;
  if (origin) { try { zelfde = new URL(origin).host === new URL(req.url).host; } catch { zelfde = false; } }
  if (req.headers.get("x-lq") === "1") return zelfde;
  return zelfde && /form-urlencoded|multipart/.test(req.headers.get("content-type") || "") && !!origin;
}
function htmlPage(title, text) {
  return new Response(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escH(title)}</title>
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#1a1612;color:#f3eee6;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}main{max-width:440px;text-align:center}h1{font-size:26px;margin:0 0 12px;color:#EBCC92}p{line-height:1.5;color:#cfc5b4}a{color:#EBCC92}</style></head>
<body><main><h1>${escH(title)}</h1><p>${escH(text)}</p><p><a href="/">Naar lumiqstore.com</a></p></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
const redirect = (to, status = 302) => new Response(null, { status, headers: { location: to, "cache-control": "no-store" } });

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const seg = path.split("/");
  const m = req.method;
  const ip = ipOf(req, context);
  try {
    // ============================================ openbaar
    if (path === "bedrijf" && m === "GET") {
      const co = (await getSettings()).company;
      return json({ naam: co.name, rechtsvorm: co.legalName, kvk: co.kvk, btw: co.vat, email: co.email, telefoon: co.phone }, 200, { "cache-control": "public, max-age=300" });
    }
    if (path === "catalogus" && m === "POST") {
      if (!eigenOrigin(req)) fail(403, "Verzoek geweigerd.");
      const ct = req.headers.get("content-type") || "";
      const r = await cat.aanvraagCatalogus(await lees(req), ip);
      if (!/json/.test(ct) && req.headers.get("x-lq") !== "1") return redirect(`/catalogus-bedankt.html${r.token ? `?t=${encodeURIComponent(r.token)}` : ""}`, 303);
      return json(r);
    }
    if (path === "catalogus/download" && m === "GET") return redirect(await cat.download(url.searchParams.get("t")));
    if (path === "offerte" && m === "POST") {
      if (!eigenOrigin(req)) fail(403, "Verzoek geweigerd.");
      const ct = req.headers.get("content-type") || "";
      const r = await cat.aanvraagOfferte(await lees(req), ip);
      if (!/json/.test(ct) && req.headers.get("x-lq") !== "1") return redirect("/bedankt.html", 303);
      return json(r);
    }
    // Meten B2B-mail: onzichtbaar plaatje (open) en ondertekende doorstuurlink (klik / catalogus).
    if (path === "t/o" && m === "GET") {
      const p = Object.fromEntries(url.searchParams);
      if (b2b.checkTrack(p)) await b2b.recordTrack({ ...p, u: undefined, ua: req.headers.get("user-agent") || "" }).catch(() => {});
      return new Response(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"), { headers: { "content-type": "image/gif", "cache-control": "no-store, max-age=0" } });
    }
    if (path === "t/k" && m === "GET") {
      const p = Object.fromEntries(url.searchParams);
      if (!b2b.checkTrack(p)) return redirect(publicBase(req) + "/");
      await b2b.recordTrack({ ...p, ua: req.headers.get("user-agent") || "" }).catch(() => {});
      let doel = ""; try { doel = Buffer.from(String(p.u), "base64url").toString(); } catch {}
      return redirect(/^https?:\/\//.test(doel) ? doel : publicBase(req) + "/");
    }
    if (path === "b2b/afmelden") {
      if (url.searchParams.get("test") === "1") return htmlPage("Afgemeld (test)", "Dit is de afmeldpagina uit een testmail. Er is niemand afgemeld.");
      const id = int(url.searchParams.get("l"));
      if (!b2b.checkUnsub(id, url.searchParams.get("t"))) return htmlPage("Link werkt niet", "Deze afmeldlink is niet geldig. Mail ons gerust, dan halen we je adres met de hand weg.");
      await b2b.unsubscribe(id);
      return htmlPage("Je bent afgemeld", "Je ontvangt geen berichten meer van Lumiq. Excuses voor het storen.");
    }

    // ============================================ inloggen
    if (path === "auth/code" && m === "POST") { if (!eigenOrigin(req)) fail(403, "Verzoek geweigerd."); const b = await lees(req); const r = await requestCode(b.email, ip); return json({ ok: true, vast: !!r?.vast }); }
    if (path === "auth/verify" && m === "POST") {
      if (!eigenOrigin(req)) fail(403, "Verzoek geweigerd.");
      const b = await lees(req); const { user, cookie } = vasteCode() && !b.email ? await verifyVast(b.code, ip) : await verifyCode(b.email, b.code);
      return json({ ok: true, user: { email: user.email, role: user.role } }, 200, { "set-cookie": cookie });
    }
    if (path === "auth/logout" && m === "POST") return json({ ok: true }, 200, { "set-cookie": await logout(req) });
    if (path === "auth/me" && m === "GET") { const u = await currentUser(req); return json({ user: u ? { email: u.email, role: u.role, name: u.name } : null, mail: mailReady(), vast: !!vasteCode() }); }

    // ============================================ Lumiq HQ
    if (seg[0] === "hq") {
      const user = requireStaff(await currentUser(req));
      if (m !== "GET" && !eigenOrigin(req)) fail(403, "Verzoek geweigerd.");
      const b = m === "GET" ? {} : await lees(req);
      const r = seg.slice(1).join("/");
      const id = int(seg[2]);
      // ---- team (AI-medewerkers, briefing, taken)
      if (r === "team" && m === "GET") {
        const [t, k, b] = await Promise.all([team.team(), team.kaarten(), team.briefing()]);
        const laatste = await q("SELECT DISTINCT ON (afdeling) afdeling, vraag, antwoord, status, created_at FROM team_vragen ORDER BY afdeling, id DESC");
        return json({ ...t, kaarten: k, briefing: b, laatste, ai: (await import("../lib/ai.mjs")).aiReady() });
      }
      if (r === "team/vragen" && m === "GET") return json({ vragen: await team.vragen(str(url.searchParams.get("afdeling"), 20)) });
      if (r === "team/vraag" && m === "POST") return json({ vraag: await team.vraagStellen(str(b.afdeling, 20), b.vraag, b.door) });
      if (r === "team/briefing" && m === "POST") { await team.maakBriefing({ force: true, budgetMs: 20000 }); return json({ briefing: await team.briefing() }); }
      if (r === "taken" && m === "GET") return json(await team.taken());
      if (r === "taken" && m === "POST") return json(await team.vink(b.dag, b.taak_id, !!b.gedaan, b.door));
      // ---- overzicht
      if (r === "overzicht" && m === "GET") return json({ ...(await overzicht()), briefing: await team.briefing() });
      // ---- B2B
      if (r === "b2b" && m === "GET") return json(await b2bDashboard());
      if (r === "leads" && m === "GET") {
        const st = str(url.searchParams.get("status"), 30), zoek = str(url.searchParams.get("q"), 100);
        const s = await getSettings();
        const params = [zoek];
        let where = "TRUE";
        if (st === "warm") where = "status IN ('reactie','interesse')";
        else if (st === "opvolgen") { params.push(String(Number(s.b2b.followupDays || 5))); where = "status = 'verstuurd' AND reply_at IS NULL AND sent_at < NOW() - ($2 || ' days')::interval"; }
        else if (st) { params.push(st); where = "status = $2"; }
        const rows = await q(`SELECT id, company, email, website, city, category, phone, status, intro, research_note, reject_reason, sent_at, followup_at, reply_at, reply_snippet, catalogus_at, error, source, created_at,
            (SELECT COUNT(*)::int FROM mail_events e WHERE e.lead_id = leads.id AND e.soort = 'open') AS opens
          FROM leads WHERE ${where} AND ($1 = '' OR company ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%' OR city ILIKE '%' || $1 || '%')
          ORDER BY updated_at DESC LIMIT 400`, params);
        const tel = await q("SELECT status, COUNT(*)::int AS n FROM leads GROUP BY status");
        return json({ leads: rows, tellingen: Object.fromEntries(tel.map((x) => [x.status, x.n])) });
      }
      if (seg[1] === "lead" && id && m === "GET") {
        const lead = await one("SELECT * FROM leads WHERE id = $1", [id]);
        if (!lead) fail(404, "Lead niet gevonden.");
        const s = await getSettings();
        const events = await q("SELECT mail, soort, url, created_at FROM mail_events WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 50", [id]);
        const mails = await q("SELECT subject, kind, ok, error, created_at FROM mail_log WHERE ref = $1 ORDER BY created_at DESC", [`lead:${id}`]);
        const aanvragen = await q("SELECT id, soort, naam, created_at FROM aanvragen WHERE lead_id = $1 ORDER BY created_at DESC", [id]);
        return json({ lead, events, mails, aanvragen, voorbeeld: { eerste: b2b.compose(lead, "eerste", s), opvolging: b2b.compose(lead, "opvolging", s) } });
      }
      if (seg[1] === "lead" && id && m === "POST") {
        const set = {}, ok = b2b.LEAD_STATUSES;
        for (const k of ["company", "city", "category", "phone", "notes", "intro", "website"]) if (b[k] !== undefined) set[k] = str(b[k], k === "notes" || k === "intro" ? 1000 : 200);
        if (b.email !== undefined) set.email = str(b.email, 200).toLowerCase() || null;
        if (b.status && ok.includes(b.status)) set.status = b.status;
        const keys = Object.keys(set);
        if (!keys.length) fail(400, "Niets om op te slaan.");
        const row = await one(`UPDATE leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => set[k])]);
        if (set.status === "afgemeld" && row?.email) await q("INSERT INTO suppressions (email, reason) VALUES ($1, 'handmatig') ON CONFLICT DO NOTHING", [row.email.toLowerCase()]);
        return json({ lead: row });
      }
      if (r === "leads" && m === "POST") return json(await b2b.addLead({ ...b, source: "handmatig" }, user.id));
      if (r === "leads/import" && m === "POST") {
        const rows = b2b.parseCsv(b.csv); let toegevoegd = 0, dubbel = 0, fout = 0;
        for (const x of rows) { try { const res = await b2b.addLead({ ...x, source: "import" }, user.id); res.duplicate ? dubbel++ : toegevoegd++; } catch { fout++; } }
        return json({ toegevoegd, dubbel, fout });
      }
      if (r === "leads/actie" && m === "POST") {
        const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean).slice(0, 1000);
        if (!ids.length) fail(400, "Selecteer eerst leads.");
        const sql = {
          goedkeuren: "UPDATE leads SET status = 'goedgekeurd', updated_at = NOW() WHERE id = ANY($1) AND status IN ('nieuw','fout') AND email IS NOT NULL",
          opvolgen: "UPDATE leads SET status = 'opvolging_goedgekeurd', updated_at = NOW() WHERE id = ANY($1) AND status IN ('verstuurd','interesse') AND reply_at IS NULL",
          overslaan: "UPDATE leads SET status = 'overgeslagen', reject_reason = 'handmatig overgeslagen', updated_at = NOW() WHERE id = ANY($1) AND status IN ('kandidaat','nieuw','goedgekeurd','fout')",
          terug: "UPDATE leads SET status = CASE WHEN email IS NULL THEN 'kandidaat' ELSE 'nieuw' END, error = '', updated_at = NOW() WHERE id = ANY($1) AND status IN ('goedgekeurd','overgeslagen','fout')",
          afspraak: "UPDATE leads SET status = 'afspraak', updated_at = NOW() WHERE id = ANY($1)",
          onderzoeken: "UPDATE leads SET status = 'kandidaat', updated_at = NOW() WHERE id = ANY($1) AND status IN ('overgeslagen','fout') AND website <> ''",
          verwijderen: "DELETE FROM leads WHERE id = ANY($1) AND sent_at IS NULL",
        }[b.actie];
        if (!sql) fail(400, "Onbekende actie.");
        const n = (await q(sql + " RETURNING id", [ids])).length;
        await audit(user.id, `leads.${b.actie}`, { n });
        return json({ ok: true, aantal: n });
      }
      if (r === "b2b/test" && m === "POST") return json(await b2b.sendTestMail(int(b.lead_id) || null, b.kind, b.aan || user.email));
      if (r === "b2b/scout" && m === "POST") return json(await b2b.runScout({ force: true }));
      if (r === "b2b/research" && m === "POST") return json(await b2b.runResearch({ max: 5, budgetMs: 20000 }));
      // ---- aanvragen (website)
      if (r === "aanvragen" && m === "GET") return json(await cat.lijst({ soort: str(url.searchParams.get("soort"), 20), status: str(url.searchParams.get("status"), 20) }));
      if (seg[1] === "aanvraag" && id && m === "POST") return json({ aanvraag: await cat.bijwerken(id, b) });
      // ---- producten, voorraad, klanten
      if (r === "producten" && m === "GET") return json({ producten: await vr.producten() });
      if (r === "producten" && m === "POST") return json({ product: await vr.productOpslaan(null, b, user.id) });
      if (seg[1] === "product" && id && m === "POST") return json({ product: await vr.productOpslaan(id, b, user.id) });
      if (r === "voorraad" && m === "GET") return json(await vr.voorraad());
      if (r === "voorraad/mutatie" && m === "POST") return json({ mutatie: await vr.mutatie(b, user.id) });
      if (r === "klanten" && m === "GET") return json({ klanten: await vr.klanten() });
      if (r === "klanten" && m === "POST") return json({ klant: await vr.klantOpslaan(null, b, user.id) });
      if (seg[1] === "klant" && id && m === "POST") return json({ klant: await vr.klantOpslaan(id, b, user.id) });
      // ---- orders
      if (r === "orders" && m === "GET") return json({ orders: await handel.orders({ status: str(url.searchParams.get("status"), 20) }) });
      if (r === "orders" && m === "POST") return json({ order: await handel.orderMaken(b, user.id) });
      if (seg[1] === "order" && id && m === "GET") return json(await handel.order(id));
      if (seg[1] === "order" && id && m === "POST") return json({ order: await handel.orderBijwerken(id, b, user.id) });
      // ---- inkoop
      if (r === "inkoop" && m === "GET") { const s = await getSettings(); return json({ behoefte: await handel.behoefte(), inkooporders: await handel.inkooporders(), instellingen: s.inkoop }); }
      if (r === "inkoop/behoefte" && m === "POST") return json({ inkoop: await handel.inkoopUitBehoefte(b, user.id) });
      if (r === "inkoop" && m === "POST") return json({ inkoop: await handel.inkoopHandmatig(b, user.id) });
      if (seg[1] === "inkoop" && id && seg[3] === "status" && m === "POST") return json({ inkoop: await handel.inkoopStatus(id, b, user.id) });
      if (seg[1] === "inkoop" && id && m === "GET") return json(await handel.inkooporder(id));
      if (seg[1] === "inkoop" && id && m === "POST") return json({ inkoop: await handel.inkoopBijwerken(id, b, user.id) });
      // ---- finance
      if (r === "finance" && m === "GET") return json(await fin.overzicht());
      if (r === "facturen" && m === "POST") return json({ factuur: await fin.factuurMaken(b, user.id) });
      if (seg[1] === "factuur" && id && seg[3] === "pdf" && m === "GET") {
        const f = await one("SELECT nummer FROM facturen WHERE id = $1", [id]);
        if (!f) fail(404, "Factuur niet gevonden.");
        return new Response(Buffer.from(await fin.factuurPdf(id)), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${f.nummer}.pdf"`, "cache-control": "no-store" } });
      }
      if (seg[1] === "factuur" && id && m === "POST") return json({ factuur: await fin.factuurActie(id, b, user.id) });
      // ---- instellingen
      if (r === "instellingen" && m === "GET") {
        const s = await getSettings();
        return json({ instellingen: s, standaard: DEFAULT_SETTINGS, horeca: HORECA, plaatsen: PLAATSEN, koppelingen: {
          mail: mailReady(), b2bMail: b2bApart() ? mailEnv("b2b").user : "", scout: b2b.scoutReady(), ai: b2b.aiReady(), toegang: (await import("../lib/auth.mjs")).toegang(),
        }, scout: (await one("SELECT value FROM settings WHERE key = 'scout_state'"))?.value || null, inbox: (await one("SELECT value FROM settings WHERE key = 'inbox_scan'"))?.value || null });
      }
      if (r === "instellingen" && m === "POST") {
        requireAdmin(user);
        const toegestaan = ["company", "finance", "inkoop", "notify", "catalogus", "b2b", "team"];
        const sleutel = String(b.sleutel || "");
        if (!toegestaan.includes(sleutel) || typeof b.waarde !== "object") fail(400, "Onbekende instelling.");
        const huidig = (await getSettings())[sleutel];
        await saveSetting(sleutel, { ...huidig, ...b.waarde });
        await audit(user.id, "instellingen", { sleutel });
        return json({ ok: true, instellingen: await getSettings() });
      }
      if (r === "logboek" && m === "GET") {
        const rows = await q(`(SELECT 'mail' AS soort, created_at, kind || CASE WHEN ok THEN '' ELSE ' (mislukt)' END AS wat, to_email || ' · ' || subject AS detail FROM mail_log ORDER BY created_at DESC LIMIT 80)
          UNION ALL (SELECT 'actie', a.created_at, a.action, COALESCE(u.email, 'systeem') || ' · ' || a.detail::text FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 80)
          ORDER BY created_at DESC LIMIT 150`);
        return json({ logboek: rows });
      }
      fail(404, "Onbekende HQ-route.");
    }
    fail(404, "Niet gevonden.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error("[api]", path, e);
    return json({ error: "Er ging iets mis. Probeer het opnieuw." }, 500);
  }
};
export const config = { path: "/api/*" };
