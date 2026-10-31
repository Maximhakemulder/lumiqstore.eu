// Draait elke 5 minuten: B2B-mail versturen, opvolging, inbox lezen, scout en research, factuurherinneringen.
// Netlify kapt geplande functies af na ongeveer 15 seconden; daarom kleine porties en mails eerst.
import { withLock, getState, saveSetting, hourAms, dayKey } from "../lib/core.mjs";
import { sendBatch, scanInbox, runScout, runResearch, runOpvolging } from "../lib/b2b.mjs";
import { runHerinneringen } from "../lib/finance.mjs";
import { runOpenVragen, runOchtend } from "../lib/team.mjs";

export default async () => {
  const started = Date.now();
  const left = () => 13000 - (Date.now() - started);
  const log = {};
  const step = async (name, fn, ttl = 20000) => { try { log[name] = await withLock(name, fn, ttl); } catch (e) { log[name] = { error: e.message }; console.log(`[tick] ${name}:`, e.message); } };

  await step("b2b-send", () => sendBatch({ max: 3, budgetMs: Math.min(7000, left() - 4000) }));
  await step("opvolging", () => runOpvolging());
  // Vragen aan het AI-team die niet direct beantwoord konden worden, en de ochtendbriefing (werkdagen vanaf 7:30).
  if (left() > 9000) await step("team-vragen", () => runOpenVragen({ max: 1, budgetMs: Math.min(9000, left() - 3000) }));
  const ochtend = await getState("ochtend_ronde", null);
  if (left() > 9000 && ochtend?.dag !== dayKey()) {
    await step("ochtend", () => runOchtend({ budgetMs: Math.min(9000, left() - 3000) }), 30000);
    if (log.ochtend && !log.ochtend.wacht && !log.ochtend.error) await saveSetting("ochtend_ronde", { dag: dayKey() }).catch(() => {});
  }
  const inbox = await getState("inbox_scan", null);
  if (left() > 8000 && (!inbox || Date.now() - Date.parse(inbox.at) > 30 * 60000)) {
    await step("inbox", () => scanInbox({ days: 14, max: 120 }), 25000);
    await saveSetting("inbox_scan", { at: new Date().toISOString(), ...(log.inbox || {}) }).catch(() => {});
  }
  if (left() > 6000) await step("scout", () => runScout());
  if (left() > 6000) await step("research", () => runResearch({ max: 4, budgetMs: left() - 3000 }));
  // Factuurherinneringen: één keer per uur tussen 9 en 17.
  const h = hourAms();
  const her = await getState("herinnering_ronde", null);
  if (left() > 4000 && h >= 9 && h < 17 && her?.uur !== `${dayKey()} ${h}`) {
    await step("herinneringen", () => runHerinneringen({ max: 3 }));
    await saveSetting("herinnering_ronde", { uur: `${dayKey()} ${h}` }).catch(() => {});
  }
  await saveSetting("tick_pulse", { at: new Date().toISOString(), ms: Date.now() - started, log }).catch(() => {});
};
export const config = { schedule: "*/5 * * * *" };
