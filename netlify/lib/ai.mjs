// Claude via de Netlify AI Gateway (Netlify zet ANTHROPIC_BASE_URL en ANTHROPIC_API_KEY) of een eigen sleutel.
import { env } from "./core.mjs";

export const aiReady = () => !!env("ANTHROPIC_API_KEY") || env("AI_FAKE") === "1";
export async function claude({ system, prompt, model, maxTokens = 1500, timeoutMs = 20000 }) {
  if (env("AI_FAKE") === "1") return globalThis.__aiFake ? globalThis.__aiFake({ system, prompt }) : "";
  const base = (env("ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/+$/, "");
  const r = await fetch(base + "/v1/messages", {
    method: "POST", headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: model || env("AI_MODEL_LICHT", "claude-haiku-5-5"), max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `status ${r.status}`);
  return (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}
// Haalt het eerste JSON-object uit een antwoord, ook als het is afgekapt.
export function parseJson(t) {
  const s = String(t || ""); const i = s.indexOf("{"); if (i < 0) return null;
  let body = s.slice(i);
  for (let n = 0; n < 3; n++) { try { return JSON.parse(body); } catch { body = n === 0 ? body.slice(0, body.lastIndexOf("}") + 1) : body + "]}"; } }
  try { return JSON.parse(s.slice(i, s.lastIndexOf("}") + 1)); } catch { return null; }
}
