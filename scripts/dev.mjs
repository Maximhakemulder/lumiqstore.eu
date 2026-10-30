// Lokaal draaien zonder Netlify: npm run dev  (of node scripts/dev.mjs --port 8888)
// Start een lokale Postgres (PGlite), past de migraties toe, serveert public/ en /api.
// Mails gaan niet de deur uit maar verschijnen in de console (ook de inlogcode).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { NetlifyDB } from "@netlify/database-dev";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8888;
const root = path.resolve("public");
const db = new NetlifyDB({ directory: process.env.LQ_DEV_DB || ".netlify/dev-db" });
const cs = await db.start();
await db.applyMigrations("./netlify/database/migrations");
Object.assign(process.env, {
  LQ_DB_URL: cs, MAIL_TRANSPORT: "capture", LQ_INSECURE_COOKIE: "1", ADMIN_EMAILS: process.env.ADMIN_EMAILS || "maxim@lumiq.test",
  AUTH_SECRET: "lokaal", PUBLIC_BASE_URL: `http://localhost:${port}`, AI_FAKE: "1",
});
globalThis.__aiFake ||= () => '{"intro":"Mooie zaak, daar hoort sfeer op tafel bij.","notitie":"lokaal"}';
const { default: api } = await import("../netlify/functions/api.mjs");
const { captured } = await import("../netlify/lib/mail.mjs");
let seen = 0;
setInterval(() => { while (seen < captured.length) { const m = captured[seen++]; console.log(`\n[mail] aan ${m.to}: ${m.subject}`); const code = String(m.subject || "").match(/\b\d{6}\b/); if (code) console.log(`[mail] code: ${code[0]}`); } }, 500);

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp4": "video/mp4", ".woff2": "font/woff2", ".txt": "text/plain" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await api(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: "half" }), { ip: "127.0.0.1" });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = path.join(root, decodeURIComponent(url.pathname));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { if ((await fs.stat(p)).isDirectory()) p = path.join(p, "index.html"); } catch {}
  try { const data = await fs.readFile(p); res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" }); res.end(data); }
  catch { if (url.pathname === "/hq") { res.writeHead(301, { location: "/hq/" }); return res.end(); }
    try { res.writeHead(404, { "content-type": "text/html" }); res.end(await fs.readFile(path.join(root, "404.html"))); } catch { res.end("404"); } }
}).listen(port, () => console.log(`Lumiq lokaal: http://localhost:${port}  (HQ: /hq, inloggen als ${process.env.ADMIN_EMAILS})`));
