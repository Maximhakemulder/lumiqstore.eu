// Lumiq HQ — één pagina, routes via #hash. Geen inline scripts of style-attributen (strikte CSP):
// alle HTML wordt met h() opgebouwd; tekst gaat altijd via textContent.
(() => {
  "use strict";
  // ------------------------------------------------------------ hulpjes
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "required" || k === "multiple") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    const add = (k) => { if (k === null || k === undefined || k === false) return; if (Array.isArray(k)) k.forEach(add); else el.append(k instanceof Node ? k : document.createTextNode(String(k))); };
    kids.forEach(add);
    return el;
  };
  const $ = (s, el = document) => el.querySelector(s);
  const app = document.getElementById("app");
  const eur = (c) => (Number(c) < 0 ? "-€ " : "€ ") + (Math.abs(Number(c || 0)) / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const eur0 = (c) => "€ " + Math.round(Number(c || 0) / 100).toLocaleString("nl-NL");
  const geld = (c) => (Number(c || 0) / 100).toFixed(2).replace(".", ",");
  const num = (n) => Number(n || 0).toLocaleString("nl-NL");
  const datum = (d) => (d ? new Date(String(d).length === 10 ? d + "T12:00:00" : d).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const kortDatum = (d) => (d ? new Date(String(d).length === 10 ? d + "T12:00:00" : d).toLocaleDateString("nl-NL", { day: "numeric", month: "short" }) : "—");
  const tijd = (d) => (d ? new Date(d).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const vandaag = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
  const pct = (p) => (p === null || p === undefined ? "—" : String(p).replace(".", ",") + "%");

  let toastTimer;
  function toast(tekst, fout = false) {
    const t = document.getElementById("toast");
    t.textContent = tekst; t.className = "aan" + (fout ? " fout" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ""), fout ? 5200 : 2800);
  }
  async function api(path, { method = "GET", body } = {}) {
    const r = await fetch("/api/" + path, { method, credentials: "same-origin", headers: { "x-lq": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json() : {};
    if (r.status === 401 && !path.startsWith("auth/")) { state.user = null; renderLogin(); throw new Error("Log opnieuw in."); }
    if (!r.ok) { const e = new Error(data.error || "Er ging iets mis."); e.data = data; throw e; }
    return data;
  }
  // Knop die een actie uitvoert, met laadstand en melding.
  const doe = (fn, okTekst) => async (ev) => {
    const b = ev?.currentTarget; if (b) b.disabled = true;
    try { const r = await fn(ev); if (okTekst) toast(typeof okTekst === "function" ? okTekst(r) : okTekst); return r; }
    catch (e) { toast(e.message, true); } finally { if (b) b.disabled = false; }
  };
  const formWaarden = (form) => { const o = {}; for (const el of form.elements) { if (!el.name) continue; if (el.type === "checkbox") o[el.name] = el.checked; else o[el.name] = el.value; } return o; };

  const state = { user: null, producten: null, instellingen: null };

  // ------------------------------------------------------------ labels
  const LEAD = { kandidaat: ["Te onderzoeken", "grijs"], nieuw: ["Te keuren", "goud"], goedgekeurd: ["In de wachtrij", "blauw"], verstuurd: ["Gemaild", "blauw"], opvolging_goedgekeurd: ["Opvolging in wachtrij", "blauw"], opgevolgd: ["Opgevolgd", "blauw"], interesse: ["Catalogus geopend", "groen"], reactie: ["Reactie", "groen"], afspraak: ["Afspraak", "groen"], klant: ["Klant", "donker"], afgemeld: ["Afgemeld", "rood"], overgeslagen: ["Overgeslagen", "grijs"], fout: ["Fout", "rood"] };
  const ORDER = { besteld: ["Besteld", "goud"], in_productie: ["In productie", "oranje"], onderweg: ["Onderweg (vlucht)", "blauw"], binnen: ["Binnen in NL", "groen"], geleverd: ["Geleverd", "donker"], geannuleerd: ["Geannuleerd", "grijs"] };
  const PO = { concept: ["Concept", "goud"], besteld: ["Besteld", "blauw"], in_productie: ["In productie", "oranje"], verzonden: ["Onderweg (vlucht)", "blauw"], ontvangen: ["Ontvangen", "groen"], geannuleerd: ["Geannuleerd", "grijs"] };
  const FACT = { concept: ["Concept", "grijs"], open: ["Open", "blauw"], vervallen: ["Vervallen", "rood"], betaald: ["Betaald", "groen"], gecrediteerd: ["Gecrediteerd", "grijs"] };
  const AANV = { nieuw: ["Nieuw", "goud"], gebeld: ["Gebeld", "blauw"], offerte: ["Offerte gestuurd", "blauw"], klant: ["Klant", "groen"], geen_interesse: ["Geen interesse", "grijs"] };
  const st = (map, k) => { const [t, c] = map[k] || [k || "—", "grijs"]; return h("span", { class: "st " + c }, t); };

  // ------------------------------------------------------------ inloggen
  function renderLogin(fout = "") {
    let email = "";
    const foutEl = h("div", { class: "fout" }, fout);
    const stap1 = h("form", { onsubmit: doe(async (e) => {
      e.preventDefault(); email = stap1.email.value.trim(); foutEl.textContent = "";
      await api("auth/code", { method: "POST", body: { email } });
      stap1.replaceWith(stap2); stap2.code.focus();
    }) },
      h("img", { src: "/hq/logo.svg", alt: "Lumiq" }), h("h1", null, "Lumiq HQ"), h("p", null, "Log in met de code die we je mailen."),
      h("label", { for: "e" }, "E-mailadres"), h("input", { id: "e", name: "email", type: "email", required: true, autocomplete: "email", placeholder: "jij@lumiqstore.eu" }),
      h("button", { class: "btn goud", type: "submit" }, "Stuur mij een code"), foutEl);
    const fout2 = h("div", { class: "fout" });
    const stap2 = h("form", { onsubmit: async (e) => {
      e.preventDefault(); fout2.textContent = "";
      try { const r = await api("auth/verify", { method: "POST", body: { email, code: stap2.code.value } }); state.user = r.user; start(); }
      catch (err) { fout2.textContent = err.message; }
    } },
      h("img", { src: "/hq/logo.svg", alt: "Lumiq" }), h("h1", null, "Check je mail"), h("p", null, "Vul de 6 cijfers in. Komt er niets binnen? Dan heeft dit adres geen toegang."),
      h("label", { for: "c" }, "Code"), h("input", { id: "c", name: "code", class: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, required: true }),
      h("button", { class: "btn goud", type: "submit" }, "Inloggen"), fout2);
    app.className = ""; app.replaceChildren(h("div", { class: "login" }, stap1));
    stap1.email.focus();
  }

  // ------------------------------------------------------------ menu en routing
  const MENU = [
    ["overzicht", "Overzicht"],
    ["kop", "Verkoop"], ["b2b", "B2B Verkoop"], ["b2b/leads", "Leads", "sub"], ["aanvragen", "Catalogus & aanvragen"], ["klanten", "Klanten"],
    ["kop", "Operatie"], ["orders", "Orders"], ["inkoop", "Inkoop"], ["voorraad", "Voorraad"], ["producten", "Producten"],
    ["kop", "Geld"], ["finance", "Finance"],
    ["kop", "Systeem"], ["instellingen", "Instellingen"], ["logboek", "Logboek"],
  ];
  let badges = {};
  function shell(route, inhoud) {
    const actief = (k) => route === k || (k !== "b2b" && route.startsWith(k + "/")) || (k === "b2b" && route.startsWith("b2b") && !route.startsWith("b2b/lead"));
    const side = h("nav", { class: "side" },
      h("div", { class: "merk" }, h("img", { src: "/hq/logo.svg", alt: "" }), h("div", null, h("b", null, "Lumiq HQ"), h("span", null, "Gosmart B.V."))),
      MENU.map(([k, t, cls]) => k === "kop" ? h("div", { class: "kop" }, t) : h("a", { href: "#" + k, class: [cls, actief(k) ? "on" : ""].filter(Boolean).join(" "), onclick: () => document.querySelector(".shell")?.classList.remove("menu") }, h("span", null, t), badges[k] ? h("span", { class: "badge" }, badges[k]) : null)),
      h("div", { class: "voet" }, h("div", null, state.user?.email || ""), h("button", { onclick: async () => { await api("auth/logout", { method: "POST" }).catch(() => {}); state.user = null; renderLogin(); } }, "Uitloggen")));
    const top = h("div", { class: "topbar" }, h("img", { src: "/hq/logo.svg", alt: "Lumiq" }), h("button", { "aria-label": "Menu", onclick: () => document.querySelector(".shell").classList.toggle("menu") }, "☰"));
    return h("div", { class: "shell" }, side, h("div", null, top, h("main", { class: "main" }, inhoud)));
  }
  const kop = (titel, uitleg, ...acties) => h("div", { class: "kop-pagina" }, h("div", null, h("h1", null, titel), uitleg ? h("p", null, uitleg) : null), acties.length ? h("div", { class: "acties" }, acties) : null);

  async function route() {
    if (!state.user) return;
    const r = (location.hash || "#overzicht").slice(1) || "overzicht";
    const [a, b, c] = r.split("/");
    const pagina = {
      overzicht: pOverzicht, b2b: b === "leads" ? () => pLeads(c || "nieuw") : b === "lead" ? () => pLead(Number(c)) : pB2b,
      aanvragen: () => pAanvragen(Number(b) || 0), klanten: pKlanten, orders: b === "nieuw" ? () => pOrderNieuw(Number(c) || 0) : b ? () => pOrder(Number(b)) : pOrders,
      inkoop: b === "nieuw" ? pInkoopNieuw : b ? () => pInkoop(Number(b)) : pInkoopLijst, voorraad: pVoorraad, producten: pProducten, finance: pFinance,
      instellingen: () => pInstellingen(b || "bedrijf"), logboek: pLogboek,
    }[a] || pOverzicht;
    app.className = "";
    const plek = h("div", null, h("p", { class: "muted" }, "Laden…"));
    app.replaceChildren(shell(r, plek));
    try { plek.replaceChildren(await pagina()); }
    catch (e) { plek.replaceChildren(h("div", { class: "melding fout" }, e.message)); }
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  async function badgesLaden() {
    try { const o = await api("hq/overzicht"); badges = { "b2b/leads": o.b2b.te_keuren || 0, aanvragen: o.catalogus.nieuw || 0, inkoop: (o.orders.zonder_inkoop ? 1 : 0) + o.inkoop.concept || 0, finance: o.finance.vervallen || 0, orders: o.orders.binnen || 0 }; } catch {}
  }

  // ------------------------------------------------------------ paneel (zijlade)
  function paneel(titel, inhoud, onSluit) {
    const sluit = () => { bg.remove(); document.removeEventListener("keydown", esc); onSluit?.(); };
    const esc = (e) => e.key === "Escape" && sluit();
    const bg = h("div", { class: "paneel-bg", onclick: (e) => e.target === bg && sluit() },
      h("div", { class: "paneel", role: "dialog", "aria-label": titel }, h("div", { class: "paneel-kop" }, h("h2", null, titel), h("button", { class: "sluit", "aria-label": "Sluiten", onclick: sluit }, "×")), inhoud));
    document.addEventListener("keydown", esc);
    document.body.append(bg);
    return sluit;
  }
  const veld = (label, el, hint) => h("label", { class: "veld" }, h("span", null, label), el, hint ? h("span", { class: "hint" }, hint) : null);
  const inp = (name, value = "", attrs = {}) => h("input", { name, value: value ?? "", type: "text", ...attrs });
  const sel = (name, opties, value) => h("select", { name }, opties.map(([v, t]) => h("option", { value: v, selected: String(v) === String(value) }, t)));

  // ------------------------------------------------------------ grafiek
  function grafiek(rijen, series, labelFn) {
    const max = Math.max(1, ...rijen.map((r) => series.reduce((t, s) => Math.max(t, Number(r[s.k] || 0)), 0)));
    return h("div", { class: "grafiek-wrap" },
      h("div", { class: "grafiek" }, rijen.map((r, i) => h("div", { class: "kol", title: series.map((s) => `${s.t}: ${s.fmt ? s.fmt(r[s.k]) : r[s.k]}`).join(" · ") },
        series.map((s) => { const b = h("i", { class: s.c }); b.style.height = (Number(r[s.k] || 0) / max) * 100 + "%"; return b; }),
        (i % Math.ceil(rijen.length / 7) === 0 || i === rijen.length - 1) ? h("span", null, labelFn(r)) : null))),
      h("div", { class: "legenda" }, series.map((s) => h("span", null, h("i", { class: "", style: { background: s.kleur } }), s.t))));
  }

  // ============================================================ OVERZICHT
  async function pOverzicht() {
    const o = await api("hq/overzicht");
    badges = { "b2b/leads": o.b2b.te_keuren || 0, aanvragen: o.catalogus.nieuw || 0, inkoop: o.inkoop.concept || 0, finance: o.finance.vervallen || 0, orders: o.orders.binnen || 0 };
    const kpi = (href, b, span, small, cls = "") => h("a", { class: "kpi " + cls, href }, h("b", null, b), h("span", null, span), small ? h("small", null, small) : null);
    const uur = new Date().getHours();
    return h("div", null,
      kop(`${uur < 12 ? "Goedemorgen" : uur < 18 ? "Goedemiddag" : "Goedenavond"}${state.user?.name ? ", " + state.user.name : ""}`, "Alles van Lumiq op één plek: verkoop aan de horeca, orders, inkoop bij de leverancier, voorraad en facturen."),
      o.instellen.length ? h("div", { class: "melding let" }, h("b", null, "Nog in te stellen: "), h("ul", { class: "lijst" }, o.instellen.map((t) => h("li", null, t)))) : null,
      h("div", { class: "grid g6" },
        kpi("#b2b", num(o.b2b.vandaag), "mails vandaag", `${num(o.b2b.week)} deze week`),
        kpi("#aanvragen", num(o.catalogus.week), "catalogus aangevraagd", `7 dagen · ${num(o.catalogus.via_mail7)} via mail geopend`, o.catalogus.week ? "goed" : ""),
        kpi("#b2b/leads/warm", num(o.b2b.warm), "warme leads", `${num(o.b2b.reacties7)} reacties in 7 dagen`, o.b2b.warm ? "goed" : ""),
        kpi("#orders", num(o.orders.open), "orders open", `${num(o.orders.in_productie)} in productie · ${num(o.orders.onderweg)} onderweg`),
        kpi("#voorraad", num(o.voorraad.leverancier), "lampen bij de leverancier", `${num(o.voorraad.magazijn)} in NL · ${eur0(o.voorraad.waarde_leverancier)}`),
        kpi("#finance", eur0(o.finance.openstaand), "openstaand", `${eur0(o.finance.omzet_maand)} omzet deze maand`, o.finance.vervallen ? "let" : "donker")),
      h("div", { class: "grid g2", style: { marginTop: "14px" } },
        h("div", { class: "kaart" }, h("h2", null, "Wacht op jou"),
          o.wacht.length ? h("ul", { class: "lijst" }, o.wacht.map((w) => h("li", null, h("a", { href: w.link, class: "pijl" }, w.tekst)))) : h("p", { class: "muted" }, "Niets dringends. Lekker bezig.")),
        h("div", { class: "kaart" }, h("h2", null, "Binnenkort binnen"),
          o.binnenkort.length ? h("ul", { class: "lijst" }, o.binnenkort.map((p) => h("li", null, h("a", { href: "#inkoop/" + p.id }, p.nummer, " "), st(PO, p.status), h("span", { class: "muted nowrap" }, p.binnen_verwacht ? "verwacht " + kortDatum(p.binnen_verwacht) : "")))) : h("p", { class: "muted" }, "Geen lopende inkooporders."),
          h("h3", { style: { marginTop: "18px" } }, "Recent"),
          o.recent.length ? h("ul", { class: "lijst" }, o.recent.map((x) => h("li", null, h("a", { href: x.soort === "aanvraag" ? "#aanvragen/" + x.id : x.soort === "order" ? "#orders/" + x.id : "#b2b/lead/" + x.id }, x.tekst), h("span", { class: "muted small nowrap" }, tijd(x.created_at))))) : h("p", { class: "muted" }, "Nog niets gebeurd."))),
      o.pulse ? h("p", { class: "muted small", style: { marginTop: "14px" } }, `Automatische ronde (elke 5 min): laatst ${tijd(o.pulse.at)}.`) : null);
  }

  // ============================================================ B2B
  const b2bTabs = (on) => h("div", { class: "tabs" }, [["b2b", "Overzicht"], ["b2b/leads/nieuw", "Leads"], ["instellingen/b2b", "Mailteksten & instellingen"]].map(([k, t]) => h("a", { href: "#" + k, class: on === k ? "on" : "" }, t)));
  async function pB2b() {
    const d = await api("hq/b2b");
    let periode = "vandaag";
    const prest = h("div");
    const tekenPrest = () => {
      const m = d.mail[periode];
      const kaartje = (b, t, s, cls = "") => h("div", { class: "kpi " + cls }, h("b", null, b), h("span", null, t), h("small", null, s));
      prest.replaceChildren(
        ...d.mail.waarschuwingen.map((w) => h("div", { class: "melding fout" }, w)),
        h("div", { class: "grid g4" },
          kaartje(num(m.verstuurd), "verstuurd", `${num(m.eerste)} eerste · ${num(m.opvolging)} opvolg`),
          kaartje(pct(m.pct.afgeleverd), "afgeleverd", `${num(m.afgeleverd)} mails`),
          kaartje(pct(m.pct.geopend), "geopend", `${num(m.geopend)} mails · indicatie`),
          kaartje(pct(m.pct.catalogus), "catalogus geopend", `${num(m.catalogus)} zaken`, m.catalogus ? "goed" : ""),
          kaartje(pct(m.pct.reacties), "reacties", `${num(m.reacties)} mails`, m.reacties ? "goed" : ""),
          kaartje(pct(m.pct.bounce), "bounce", `${num(m.bounces)} kwamen niet aan`),
          kaartje(pct(m.pct.afmeldingen), "afgemeld", `${num(m.afmeldingen)} mails`),
          kaartje(pct(m.pct.klachten), "klachten", `${num(m.klachten)} als spam/klacht`)),
        h("p", { class: "hint", style: { marginTop: "8px" } }, "Percentages t.o.v. afgeleverde mails. Geopend is een indicatie. Een klik op de catalogus is het sterkste signaal: dat zijn je warme leads. Richtwaarden: bounce onder 3%, klachten bijna 0."));
      for (const b of perBtns.children) b.classList.toggle("on", b.dataset.p === periode);
    };
    const perBtns = h("div", { class: "chips" }, [["vandaag", "Vandaag"], ["gisteren", "Gisteren"], ["d7", "7 dagen"], ["d30", "30 dagen"], ["alles", "Alles"]].map(([k, t]) => h("button", { class: "chip", "data-p": k, onclick: () => { periode = k; tekenPrest(); } }, t)));
    tekenPrest();
    const v = d.verzenden, t = d.totaal;
    const balk = h("div", { class: "balk" }, h("i", { style: { width: Math.min(100, (v.vandaag / Math.max(1, v.max)) * 100) + "%" } }));
    return h("div", null,
      kop("B2B Verkoop", "De scout zoekt horecazaken, research vindt hun mailadres, jij keurt goed en de mailer stuurt ze de catalogus. Klikt iemand op de catalogus, dan krijg je een melding: bel ze.",
        h("button", { class: "btn licht", onclick: doe(async () => { const r = await api("hq/b2b/research", { method: "POST", body: {} }); route(); return r; }, (r) => `${r.done} zaken onderzocht`) }, "Research nu"),
        h("button", { class: "btn licht", onclick: doe(async () => api("hq/b2b/scout", { method: "POST", body: {} }), (r) => r.submitted ? `Scout zoekt in ${r.submitted} categorieën` : r.skipped || "Klaar") }, "Scout nu zoeken"),
        h("a", { class: "btn goud", href: "#b2b/leads/nieuw" }, `Naar de leads${t.te_keuren ? ` (${t.te_keuren} te keuren)` : ""}`)),
      b2bTabs("b2b"),
      !v.mail ? h("div", { class: "melding let" }, "De mail is nog niet ingesteld: zet MAIL_USER en MAIL_PASSWORD van info@lumiqstore.eu in Netlify.") : null,
      !d.scout.klaar ? h("div", { class: "melding info" }, "De scout heeft een Outscraper-sleutel nodig (OUTSCRAPER_API_KEY in Netlify). Tot die tijd kun je zelf leads toevoegen of een CSV importeren.") : null,
      h("div", { class: "grid g5" },
        h("a", { class: "kpi", href: "#b2b/leads/" }, h("b", null, num(t.leads)), h("span", null, "zaken gevonden"), h("small", null, `${num(t.met_mail)} met mailadres`)),
        h("a", { class: "kpi", href: "#b2b/leads/nieuw" }, h("b", null, num(t.te_keuren)), h("span", null, "te keuren"), h("small", null, `${num(t.te_onderzoeken)} nog te onderzoeken`)),
        h("a", { class: "kpi", href: "#b2b/leads/verstuurd" }, h("b", null, num(t.verstuurd)), h("span", null, "gemaild"), h("small", null, `${num(t.afgemeld)} afgemeld`)),
        h("a", { class: "kpi goed", href: "#b2b/leads/warm" }, h("b", null, num(t.catalogus)), h("span", null, "catalogus geopend"), h("small", null, `${num(t.reacties)} reacties`)),
        h("a", { class: "kpi", href: "#b2b/leads/klant" }, h("b", null, num(t.afspraken)), h("span", null, "afspraken"), h("small", null, `${num(t.klanten)} klant geworden`))),
      h("div", { class: "kaart", style: { marginTop: "14px" } }, h("div", { class: "kaart-kop" }, h("h2", null, "Mailprestaties"), perBtns), prest),
      h("div", { class: "grid g2", style: { marginTop: "14px" } },
        h("div", { class: "kaart" }, h("div", { class: "kaart-kop" }, h("h2", null, "Vandaag"), h("span", { class: "st " + (v.open ? "groen" : "grijs") }, v.open ? "Verzenden open" : v.weekend ? "Weekend: geen mail" : "Buiten verzendtijd")),
          balk, h("h3", { style: { margin: "10px 0 2px", fontSize: "22px" } }, `${v.vandaag} van ${v.max} mails verstuurd`), h("p", { class: "muted", style: { marginTop: 0 } }, `nog ${v.rest} ruimte vandaag · ${v.perUurNu} per uur · ${v.uren[0]}:00–${v.uren[1]}:00 op werkdagen`),
          h("dl", { class: "info" },
            h("dt", null, "In de wachtrij"), h("dd", null, `${v.wachtrij.eerste} eerste mails · ${v.wachtrij.opvolging} opvolgmails`),
            h("dt", null, "Klaar voor opvolging"), h("dd", null, v.opvolgingKlaar ? h("a", { href: "#b2b/leads/opvolgen" }, `${v.opvolgingKlaar} zaken`) : "0", v.autoGoedkeuren ? " (gaat automatisch)" : ""),
            h("dt", null, "Nieuw gevonden"), h("dd", null, num(d.vandaag.gevonden)), h("dt", null, "Onderzocht"), h("dd", null, num(d.vandaag.onderzocht)),
            h("dt", null, "Catalogus geopend"), h("dd", null, num(d.vandaag.catalogus)), h("dt", null, "Reacties"), h("dd", null, num(d.vandaag.reacties)),
            h("dt", null, "Inbox gelezen"), h("dd", null, d.inbox?.at ? tijd(d.inbox.at) + (d.inbox.error ? ` · ${d.inbox.error}` : "") : "nog niet"))),
        h("div", { class: "kaart" }, h("div", { class: "kaart-kop" }, h("h2", null, "Waar we zoeken"), h("span", { class: "st " + (d.scout.actief ? "groen" : "grijs") }, d.scout.actief ? "Scout aan" : "Scout uit")),
          h("p", { class: "muted", style: { marginTop: 0 } }, `Elke werkdag vanaf 7:00, ongeveer ${d.scout.perDag} zaken per dag.${d.scout.laatsteDag ? ` Laatst gezocht: ${datum(d.scout.laatsteDag)}.` : ""}${d.scout.bezig ? ` ${d.scout.bezig} zoekopdrachten lopen nog.` : ""}`),
          h("div", { class: "chips" }, d.scout.categorieen.map((c) => h("span", { class: "chip on" }, c))),
          h("div", { class: "chips" }, d.scout.plaatsen.map((c) => h("span", { class: "chip" }, c))),
          d.scout.plan.length ? h("ul", { class: "lijst" }, d.scout.plan.slice(0, 6).map((p) => h("li", null, h("span", null, h("b", null, p.categorie), " in ", p.volgende), h("span", { class: "muted small" }, `ronde ${p.rondes + 1} · ${p.gedaan} van ${d.scout.plaatsen.length} plaatsen`)))) : null)),
      h("div", { class: "kaart", style: { marginTop: "14px" } }, h("h2", null, "Laatste 14 dagen"),
        grafiek(d.dagen, [{ k: "verstuurd", t: "Verstuurd", c: "a", kleur: "#1a1612" }, { k: "catalogus", t: "Catalogus geopend", c: "b", kleur: "#c9a15c" }, { k: "reacties", t: "Reacties", c: "c", kleur: "#cbbfa9" }], (r) => kortDatum(r.dag))),
      h("div", { class: "grid g2", style: { marginTop: "14px" } },
        tabelKaart("Per soort zaak", ["Soort", "Gevonden", "Met mail", "Gemaild", "Catalogus", "Reacties"], d.perCategorie.map((r) => [r.naam, num(r.gevonden), num(r.met_mail), num(r.verstuurd), num(r.catalogus), num(r.reacties)])),
        tabelKaart("Per plaats", ["Plaats", "Gevonden", "Met mail", "Gemaild", "Reacties"], d.perPlaats.map((r) => [r.naam, num(r.gevonden), num(r.met_mail), num(r.verstuurd), num(r.reacties)]))));
  }
  function tabelKaart(titel, koppen, rijen) {
    return h("div", { class: "kaart" }, h("h2", null, titel), rijen.length ? h("div", { class: "tabelwrap" }, h("table", null, h("thead", null, h("tr", null, koppen.map((k, i) => h("th", { class: i ? "num" : "" }, k)))), h("tbody", null, rijen.map((r) => h("tr", null, r.map((c, i) => h("td", { class: i ? "num" : "" }, c))))))) : h("p", { class: "muted" }, "Nog geen gegevens."));
  }

  const LEAD_FILTERS = [["nieuw", "Te keuren"], ["warm", "Warm"], ["goedgekeurd", "Wachtrij"], ["verstuurd", "Gemaild"], ["opvolgen", "Klaar voor opvolging"], ["opgevolgd", "Opgevolgd"], ["kandidaat", "Te onderzoeken"], ["afspraak", "Afspraak"], ["klant", "Klant"], ["overgeslagen", "Overgeslagen"], ["afgemeld", "Afgemeld"], ["fout", "Fout"], ["", "Alle"]];
  async function pLeads(filter) {
    const zoekEl = h("input", { type: "search", class: "zoek", placeholder: "Zoek zaak, plaats of mail" });
    const plek = h("div");
    const geselecteerd = new Set();
    const bulk = h("div", { class: "acties" });
    async function laad() {
      const d = await api(`hq/leads?status=${encodeURIComponent(filter)}&q=${encodeURIComponent(zoekEl.value)}`);
      const tel = d.tellingen; const telVan = (k) => k === "warm" ? (tel.reactie || 0) + (tel.interesse || 0) : k === "" ? Object.values(tel).reduce((a, b) => a + b, 0) : k === "opvolgen" ? null : tel[k] || 0;
      chips.replaceChildren(...LEAD_FILTERS.map(([k, t]) => h("a", { class: "chip" + (k === filter ? " on" : ""), href: "#b2b/leads/" + k }, t, telVan(k) !== null ? h("span", { class: "n" }, telVan(k)) : null)));
      geselecteerd.clear(); tekenBulk();
      if (!d.leads.length) return plek.replaceChildren(h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, filter === "nieuw" ? "Niets te keuren. De research vult deze lijst vanzelf zodra de scout zaken vindt." : "Geen leads in deze lijst.")));
      const alle = h("input", { type: "checkbox", "aria-label": "Alles selecteren", onchange: (e) => { plek.querySelectorAll("tbody input[type=checkbox]").forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event("change")); }); } });
      plek.replaceChildren(h("div", { class: "tabelwrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, alle), h("th", null, "Zaak"), h("th", null, "Soort · plaats"), h("th", null, "Mailadres"), h("th", null, "Status"), h("th", null, "Openingszin / reden"), h("th", null, "Laatst"))),
        h("tbody", null, d.leads.map((l) => h("tr", { class: "klik", onclick: (e) => { if (e.target.tagName !== "INPUT") location.hash = "#b2b/lead/" + l.id; } },
          h("td", null, h("input", { type: "checkbox", onchange: (e) => { e.target.checked ? geselecteerd.add(l.id) : geselecteerd.delete(l.id); tekenBulk(); } })),
          h("td", null, h("b", null, l.company), l.website ? h("div", { class: "small muted" }, l.website.replace(/^https?:\/\//, "")) : null),
          h("td", { class: "small" }, [l.category, l.city].filter(Boolean).join(" · ")),
          h("td", { class: "small" }, l.email || h("span", { class: "muted" }, "—")),
          h("td", null, st(LEAD, l.status), l.catalogus_at && l.status !== "interesse" ? h("div", { class: "small muted" }, "catalogus geopend") : null, l.opens ? h("div", { class: "small muted" }, `${l.opens}× geopend`) : null),
          h("td", { class: "small" }, l.reply_snippet ? `"${l.reply_snippet.slice(0, 110)}"` : l.reject_reason || l.error || l.intro || l.research_note || ""),
          h("td", { class: "small muted nowrap" }, tijd(l.reply_at || l.catalogus_at || l.followup_at || l.sent_at || l.created_at))))))));
    }
    function tekenBulk() {
      const n = geselecteerd.size;
      const knop = (actie, tekst, cls = "licht") => h("button", { class: `btn klein ${cls}`, disabled: !n, onclick: doe(async () => { const r = await api("hq/leads/actie", { method: "POST", body: { ids: [...geselecteerd], actie } }); await laad(); badgesLaden(); return r; }, (r) => `${r.aantal} bijgewerkt`) }, tekst);
      bulk.replaceChildren(h("span", { class: "muted small" }, n ? `${n} geselecteerd` : "Selecteer leads voor een actie"),
        knop("goedkeuren", "Goedkeuren en mailen", "goud"), knop("opvolgen", "Opvolgmail sturen"), knop("overslaan", "Overslaan"), knop("terug", "Terugzetten"), knop("onderzoeken", "Opnieuw onderzoeken"), knop("afspraak", "Afspraak"), knop("verwijderen", "Verwijderen", "rood"));
    }
    const chips = h("div", { class: "chips" });
    let zt; zoekEl.addEventListener("input", () => { clearTimeout(zt); zt = setTimeout(laad, 300); });
    await laad();
    return h("div", null,
      kop("Leads", "Horecazaken die we mailen. Keur goed wat past; de mailer verstuurt binnen de verzendtijden en de daglimiet.",
        h("button", { class: "btn licht", onclick: () => leadToevoegen(laad) }, "Lead toevoegen"), h("button", { class: "btn licht", onclick: () => importeren(laad) }, "CSV importeren")),
      b2bTabs("b2b/leads/nieuw"), chips, h("div", { class: "kaart-kop" }, bulk, zoekEl), plek);
  }
  function leadToevoegen(klaar) {
    const f = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); const r = await api("hq/leads", { method: "POST", body: formWaarden(f) }); if (r.duplicate) throw new Error("Deze zaak (mailadres of website) staat er al in."); sluit(); klaar(); }, "Lead toegevoegd") },
      h("div", { class: "rij" }, veld("Naam van de zaak", inp("company", "", { required: true })), veld("Mailadres", inp("email", "", { type: "email" }), "Leeg = de research zoekt het op de website.")),
      h("div", { class: "rij" }, veld("Website", inp("website")), veld("Plaats", inp("city")), veld("Soort zaak", inp("category", "restaurant")), veld("Telefoon", inp("phone"))),
      veld("Notities", h("textarea", { name: "notes" })), h("div", null, h("button", { class: "btn goud", type: "submit" }, "Toevoegen")));
    const sluit = paneel("Lead toevoegen", f);
  }
  function importeren(klaar) {
    const ta = h("textarea", { class: "groot", placeholder: "zaak;email;website;plaats;soort\nBrasserie Haven;info@haven.nl;haven.nl;Rotterdam;brasserie" });
    const sluit = paneel("CSV importeren", h("div", { class: "form" }, h("p", { class: "muted" }, "Plak een lijst met een kopregel. Kolommen: zaak, email, website, plaats, soort, telefoon (; of ,). Afgemelde adressen worden overgeslagen."), ta,
      h("div", null, h("button", { class: "btn goud", onclick: doe(async () => { const r = await api("hq/leads/import", { method: "POST", body: { csv: ta.value } }); sluit(); klaar(); return r; }, (r) => `${r.toegevoegd} toegevoegd, ${r.dubbel} stonden er al`) }, "Importeren"))));
  }
  async function pLead(id) {
    const d = await api("hq/lead/" + id);
    const l = d.lead;
    let mailSoort = l.status === "verstuurd" || l.status === "opgevolgd" ? "opvolging" : "eerste";
    const voorbeeld = h("pre", { class: "mail" });
    const tekenMail = () => { const m = d.voorbeeld[mailSoort]; voorbeeld.textContent = `Onderwerp: ${m.subject}\n\n${m.body}`; for (const b of mailTabs.children) b.classList.toggle("on", b.dataset.k === mailSoort); };
    const mailTabs = h("div", { class: "chips" }, [["eerste", "Eerste mail"], ["opvolging", "Opvolgmail"]].map(([k, t]) => h("button", { class: "chip", "data-k": k, onclick: () => { mailSoort = k; tekenMail(); } }, t)));
    tekenMail();
    const f = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); await api("hq/lead/" + id, { method: "POST", body: formWaarden(f) }); route(); }, "Opgeslagen") },
      h("div", { class: "rij" }, veld("Naam", inp("company", l.company)), veld("Mailadres", inp("email", l.email || "", { type: "email" })), veld("Telefoon", inp("phone", l.phone))),
      h("div", { class: "rij" }, veld("Plaats", inp("city", l.city)), veld("Soort", inp("category", l.category)), veld("Status", sel("status", Object.entries(LEAD).map(([k, [t]]) => [k, t]), l.status))),
      veld("Openingszin in de mail", h("textarea", { name: "intro" }, l.intro), "Komt direct na \"Hoi,\". Leeg = zonder persoonlijke zin."),
      veld("Notities", h("textarea", { name: "notes" }, l.notes)), h("div", null, h("button", { class: "btn", type: "submit" }, "Opslaan")));
    const actie = (a, t, cls = "licht") => h("button", { class: `btn ${cls}`, onclick: doe(async () => { await api("hq/leads/actie", { method: "POST", body: { ids: [id], actie: a } }); route(); }, "Bijgewerkt") }, t);
    return h("div", null,
      h("p", null, h("a", { href: "#b2b/leads/nieuw" }, "← Leads")),
      kop(l.company, [l.category, l.city, l.website].filter(Boolean).join(" · "),
        l.status === "nieuw" ? actie("goedkeuren", "Goedkeuren en mailen", "goud") : null,
        ["verstuurd", "interesse"].includes(l.status) && !l.reply_at ? actie("opvolgen", "Opvolgmail sturen") : null,
        h("a", { class: "btn licht", href: `#orders/nieuw/0?lead=${id}`, onclick: (e) => { e.preventDefault(); orderVoorLead(l); } }, "Order maken"),
        h("button", { class: "btn licht", onclick: doe(() => api("hq/b2b/test", { method: "POST", body: { lead_id: id, kind: mailSoort } }), (r) => `Testmail naar ${r.aan}`) }, "Testmail naar mij")),
      h("div", { class: "grid g2" },
        h("div", { class: "stack" },
          h("div", { class: "kaart" }, h("dl", { class: "info" },
            h("dt", null, "Status"), h("dd", null, st(LEAD, l.status)), h("dt", null, "Bron"), h("dd", null, l.source),
            h("dt", null, "Gemaild"), h("dd", null, tijd(l.sent_at)), h("dt", null, "Opgevolgd"), h("dd", null, tijd(l.followup_at)),
            h("dt", null, "Catalogus geopend"), h("dd", null, tijd(l.catalogus_at)), h("dt", null, "Reactie"), h("dd", null, l.reply_at ? tijd(l.reply_at) : "—"),
            l.reply_snippet ? [h("dt", null, "Bericht"), h("dd", null, `"${l.reply_snippet}"`)] : null,
            l.research_note ? [h("dt", null, "Research"), h("dd", null, l.research_note)] : null,
            l.reject_reason ? [h("dt", null, "Reden"), h("dd", null, l.reject_reason)] : null,
            l.error ? [h("dt", null, "Fout"), h("dd", null, l.error)] : null)),
          h("div", { class: "kaart" }, h("h2", null, "Gegevens"), f)),
        h("div", { class: "stack" },
          h("div", { class: "kaart" }, h("div", { class: "kaart-kop" }, h("h2", null, "De mail"), mailTabs), voorbeeld, h("p", { class: "hint" }, "Teksten aanpassen: Instellingen › B2B. De cataloguslink wordt een knop; klikken worden gemeten.")),
          h("div", { class: "kaart" }, h("h2", null, "Activiteit"),
            [...d.mails.map((m) => ({ t: m.created_at, x: `Mail: ${m.subject}${m.ok ? "" : " (mislukt)"}` })), ...d.events.map((e) => ({ t: e.created_at, x: e.soort === "catalogus" ? "Catalogus geopend" : e.soort === "open" ? `Mail geopend (${e.mail})` : `Link geklikt: ${e.url}` })), ...d.aanvragen.map((a) => ({ t: a.created_at, x: `Via website: ${a.soort} (${a.naam})` }))]
              .sort((a, b) => new Date(b.t) - new Date(a.t)).map((e) => h("li", null, h("span", null, e.x), h("span", { class: "muted small nowrap" }, tijd(e.t))))
              .reduce((ul, li) => (ul.append(li), ul), h("ul", { class: "lijst" }))))));
  }
  function orderVoorLead(l) { sessionStorage.setItem("lq-order-klant", JSON.stringify({ bedrijf: l.company, email: l.email || "", telefoon: l.phone || "", plaats: l.city || "", lead_id: l.id })); location.hash = "#orders/nieuw"; }

  // ============================================================ AANVRAGEN (website)
  async function pAanvragen(open) {
    const d = await api("hq/aanvragen");
    const s = d.stats;
    const rij = (a) => h("tr", { class: "klik", onclick: () => aanvraagPaneel(a) },
      h("td", null, h("span", { class: "st " + (a.soort === "offerte" ? "donker" : "goud") }, a.soort === "offerte" ? "Offerte" : "Catalogus"), a.demo ? h("div", { class: "small" }, "wil demo") : null),
      h("td", null, h("b", null, a.bedrijf || "—"), h("div", { class: "small muted" }, a.naam)),
      h("td", { class: "small" }, a.email, a.telefoon ? h("div", null, a.telefoon) : null),
      h("td", { class: "small" }, a.tafels || "—"),
      h("td", { class: "num" }, a.soort === "catalogus" ? (a.downloads ? `${a.downloads}×` : h("span", { class: "muted" }, "nog niet")) : "—"),
      h("td", null, st(AANV, a.status), a.lead_id ? h("div", { class: "small muted" }, "gemaild via B2B") : null),
      h("td", { class: "small muted nowrap" }, tijd(a.created_at)));
    const el = h("div", null,
      kop("Catalogus & aanvragen", "Wie de catalogus aanvraagt op de website of opent vanuit een B2B-mail, en offerteaanvragen. Elke aanvrager krijgt de catalogus direct in de mail."),
      h("div", { class: "grid g6" },
        h("div", { class: "kpi goed" }, h("b", null, num(s.catalogusVandaag)), h("span", null, "aanvragen vandaag"), h("small", null, `${num(s.catalogus7)} in 7 dagen`)),
        h("div", { class: "kpi" }, h("b", null, num(s.catalogus)), h("span", null, "catalogus via website"), h("small", null, `${num(s.gedownload)} echt gedownload`)),
        h("div", { class: "kpi" }, h("b", null, num(s.viaMail)), h("span", null, "geopend via B2B-mail"), h("small", null, `${num(s.viaMailKliks)} kliks`)),
        h("div", { class: "kpi" }, h("b", null, num(s.offertes)), h("span", null, "offerteaanvragen"), h("small", null, `${num(s.offertes7)} in 7 dagen`)),
        h("div", { class: "kpi" }, h("b", null, num(s.demo)), h("span", null, "willen een demo")),
        h("div", { class: "kpi donker" }, h("b", null, num(s.klant)), h("span", null, "klant geworden"), h("small", null, `${num(s.nieuw)} nog op te volgen`))),
      h("div", { class: "kaart", style: { marginTop: "14px" } }, h("div", { class: "kaart-kop" }, h("h2", null, "Catalogus per dag"), h("span", { class: "muted small" }, "laatste 30 dagen · bron: " + d.perBron.map((b) => `${b.bron} ${b.n}`).join(", "))),
        grafiek(d.dagen, [{ k: "website", t: "Via website", c: "a", kleur: "#1a1612" }, { k: "mail", t: "Via B2B-mail", c: "b", kleur: "#c9a15c" }], (r) => kortDatum(r.dag))),
      h("h2", { style: { margin: "22px 0 10px" } }, "Aanvragen via de website"),
      d.aanvragen.length ? h("div", { class: "tabelwrap" }, h("table", null, h("thead", null, h("tr", null, ["Soort", "Zaak", "Contact", "Tafels", "Download", "Status", "Wanneer"].map((k, i) => h("th", { class: i === 4 ? "num" : "" }, k)))), h("tbody", null, d.aanvragen.map(rij)))) : h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, "Nog geen aanvragen. Ze komen hier binnen zodra iemand het formulier op de website invult.")),
      h("h2", { style: { margin: "22px 0 10px" } }, "Catalogus geopend vanuit een B2B-mail"),
      d.mailLeads.length ? h("div", { class: "tabelwrap" }, h("table", null, h("thead", null, h("tr", null, ["Zaak", "Plaats", "Telefoon", "Status", "Eerst geopend", "Keer"].map((k) => h("th", null, k)))),
        h("tbody", null, d.mailLeads.map((l) => h("tr", { class: "klik", onclick: () => (location.hash = "#b2b/lead/" + l.id) }, h("td", null, h("b", null, l.company), h("div", { class: "small muted" }, l.category)), h("td", null, l.city), h("td", null, l.phone || "—"), h("td", null, st(LEAD, l.status)), h("td", { class: "small" }, tijd(l.eerst)), h("td", null, l.keer)))))) : h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, "Nog niemand. Zodra iemand in een B2B-mail op de catalogus klikt, staat die hier (en krijg je een melding).")));
    if (open) { const a = d.aanvragen.find((x) => x.id === open); if (a) setTimeout(() => aanvraagPaneel(a), 0); }
    return el;
  }
  function aanvraagPaneel(a) {
    const f = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); await api("hq/aanvraag/" + a.id, { method: "POST", body: formWaarden(f) }); sluit(); route(); badgesLaden(); }, "Opgeslagen") },
      h("dl", { class: "info" }, h("dt", null, "Soort"), h("dd", null, a.soort), h("dt", null, "Naam"), h("dd", null, a.naam), h("dt", null, "Zaak"), h("dd", null, a.bedrijf || "—"),
        h("dt", null, "E-mail"), h("dd", null, h("a", { href: "mailto:" + a.email }, a.email)), h("dt", null, "Telefoon"), h("dd", null, a.telefoon ? h("a", { href: "tel:" + a.telefoon }, a.telefoon) : "—"),
        h("dt", null, "Tafels / aantal"), h("dd", null, a.tafels || "—"), a.interesse ? [h("dt", null, "Interesse"), h("dd", null, a.interesse)] : null, h("dt", null, "Demo"), h("dd", null, a.demo ? "Ja, wil een demo" : "Nee"),
        a.bericht ? [h("dt", null, "Bericht"), h("dd", null, a.bericht)] : null, h("dt", null, "Gedownload"), h("dd", null, a.downloads ? `${a.downloads}× (eerst ${tijd(a.gedownload_at)})` : "nog niet"),
        h("dt", null, "Bron"), h("dd", null, a.bron), h("dt", null, "Binnen"), h("dd", null, tijd(a.created_at))),
      veld("Status", sel("status", Object.entries(AANV).map(([k, [t]]) => [k, t]), a.status)), veld("Notitie", h("textarea", { name: "notitie" }, a.notitie)),
      h("div", { class: "acties" }, h("button", { class: "btn", type: "submit" }, "Opslaan"),
        h("button", { class: "btn goud", type: "button", onclick: () => { sessionStorage.setItem("lq-order-klant", JSON.stringify({ bedrijf: a.bedrijf || a.naam, contact: a.naam, email: a.email, telefoon: a.telefoon, lead_id: a.lead_id, aanvraag_id: a.id })); sluit(); location.hash = "#orders/nieuw"; } }, "Order maken")));
    const sluit = paneel(a.bedrijf || a.naam, f);
  }

  // ============================================================ KLANTEN
  async function pKlanten() {
    const { klanten } = await api("hq/klanten");
    return h("div", null, kop("Klanten", "Horecazaken die bij Lumiq bestellen.", h("button", { class: "btn goud", onclick: () => klantPaneel(null) }, "Klant toevoegen")),
      klanten.length ? h("div", { class: "tabelwrap" }, h("table", null, h("thead", null, h("tr", null, ["Zaak", "Contact", "Plaats", "Orders", "Omzet (excl. btw)"].map((k, i) => h("th", { class: i > 2 ? "num" : "" }, k)))),
        h("tbody", null, klanten.map((k) => h("tr", { class: "klik", onclick: () => klantPaneel(k) }, h("td", null, h("b", null, k.bedrijf)), h("td", { class: "small" }, k.contact, k.email ? h("div", { class: "muted" }, k.email) : null), h("td", null, k.plaats), h("td", { class: "num" }, k.orders), h("td", { class: "num" }, eur(k.omzet_cents))))))) : h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, "Nog geen klanten. Een klant ontstaat ook vanzelf bij de eerste order.")));
  }
  function klantPaneel(k) {
    const f = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); await api(k ? "hq/klant/" + k.id : "hq/klanten", { method: "POST", body: formWaarden(f) }); sluit(); route(); }, "Opgeslagen") },
      h("div", { class: "rij" }, veld("Naam van de zaak", inp("bedrijf", k?.bedrijf, { required: true })), veld("Contactpersoon", inp("contact", k?.contact))),
      h("div", { class: "rij" }, veld("E-mail (facturen)", inp("email", k?.email, { type: "email" })), veld("Telefoon", inp("telefoon", k?.telefoon))),
      h("div", { class: "rij" }, veld("Adres", inp("adres", k?.adres)), veld("Postcode", inp("postcode", k?.postcode)), veld("Plaats", inp("plaats", k?.plaats)), veld("Land", inp("land", k?.land || "Nederland"))),
      h("div", { class: "rij" }, veld("KvK", inp("kvk", k?.kvk)), veld("Btw-nummer", inp("btw_nummer", k?.btw_nummer))),
      veld("Notities", h("textarea", { name: "notities" }, k?.notities || "")),
      h("div", { class: "acties" }, h("button", { class: "btn goud", type: "submit" }, "Opslaan"), k ? h("button", { class: "btn licht", type: "button", onclick: () => { sessionStorage.setItem("lq-order-klant-id", String(k.id)); sluit(); location.hash = "#orders/nieuw"; } }, "Order voor deze klant") : null));
    const sluit = paneel(k ? k.bedrijf : "Nieuwe klant", f);
  }

  // ============================================================ PRODUCTEN
  async function productenLaden(fris = false) { if (!state.producten || fris) state.producten = (await api("hq/producten")).producten; return state.producten; }
  const prodNaam = (p) => `${p.code} · ${p.stijl ? p.stijl + " " : ""}${p.naam}`;
  async function pProducten() {
    const producten = await productenLaden(true);
    const series = [...new Set(producten.map((p) => p.serie))];
    const leeg = producten.filter((p) => p.actief && (!p.verkoop_cents || !p.inkoop_cents)).length;
    return h("div", null,
      kop("Producten", `${producten.filter((p) => p.actief).length} modellen in ${series.length} series. Klik een model om prijzen, MOQ en leveranciersnummer aan te passen.`, h("button", { class: "btn goud", onclick: () => productPaneel(null) }, "Product toevoegen")),
      leeg ? h("div", { class: "melding let" }, `${leeg} modellen hebben nog geen inkoop- of verkoopprijs. Vul ze in, dan kloppen orders, marges en voorraadwaarde.`) : null,
      series.map((s) => { const ps = producten.filter((p) => p.serie === s); return [
        h("div", { class: "serie-kop" }, h("h2", null, `${s} series`), h("span", { class: "muted" }, `${ps[0]?.stijl || ""} · ${ps.length} modellen`)),
        h("div", { class: "prod-grid" }, ps.map((p) => h("button", { class: "prod" + (p.actief ? "" : " uit"), onclick: () => productPaneel(p) },
          h("div", { class: "im" }, p.afbeelding ? h("img", { src: p.afbeelding, alt: "", loading: "lazy" }) : null),
          h("b", null, `${p.naam} `, h("span", { class: "muted" }, p.code)),
          h("div", { class: "r" }, h("span", null, p.maat || ""), h("span", null, p.leverancier_code ? "lev. " + p.leverancier_code : "")),
          h("div", { class: "r" }, h("span", null, p.inkoop_cents ? "in " + eur(p.inkoop_cents) : "inkoop ?"), h("span", null, p.verkoop_cents ? "uit " + eur(p.verkoop_cents) : "verkoop ?")),
          h("div", { class: "r" }, h("span", null, `MOQ ${p.moq}`), h("span", null, p.bij_leverancier ? `${p.bij_leverancier} bij lev.` : ""))))) ]; }));
  }
  function productPaneel(p) {
    const f = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); const w = formWaarden(f); await api(p ? "hq/product/" + p.id : "hq/producten", { method: "POST", body: w }); sluit(); state.producten = null; route(); }, "Opgeslagen") },
      p?.afbeelding ? h("img", { src: p.afbeelding, alt: "", class: "thumb", style: { width: "120px", height: "120px" } }) : null,
      h("div", { class: "rij" }, veld("Serie", inp("serie", p?.serie, { required: true, placeholder: "1300" })), veld("Modelnummer", inp("code", p?.code, { required: true, placeholder: "1301" })), veld("Naam / kleur", inp("naam", p?.naam, { required: true }))),
      h("div", { class: "rij" }, veld("Stijl", inp("stijl", p?.stijl)), veld("Maat", inp("maat", p?.maat)), veld("Materiaal", inp("materiaal", p?.materiaal))),
      h("div", { class: "rij" }, veld("Modelnummer leverancier", inp("leverancier_code", p?.leverancier_code), "Komt op de bestellijst voor de leverancier."), veld("MOQ (minimale productie)", inp("moq", p?.moq ?? 50, { type: "number", min: 1 }))),
      h("div", { class: "rij" }, veld("Inkoopprijs per stuk (excl. btw)", inp("inkoop", p ? geld(p.inkoop_cents) : "", { inputmode: "decimal", placeholder: "0,00" })), veld("Verkoopprijs per stuk (excl. btw)", inp("verkoop", p ? geld(p.verkoop_cents) : "", { inputmode: "decimal", placeholder: "0,00" }))),
      veld("Afbeelding (pad of URL)", inp("afbeelding", p?.afbeelding, { placeholder: "/media/collectie/p1301.jpg" })),
      veld("Notities", h("textarea", { name: "notities" }, p?.notities || "")),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "actief", checked: p ? p.actief : true }), "Actief (in de collectie)"),
      p ? h("p", { class: "hint" }, `Voorraad: ${p.bij_leverancier} bij de leverancier (${p.vrij_bij_leverancier} vrij) · ${p.in_magazijn} in NL · ${p.in_productie} in productie · ${p.onderweg} onderweg`) : null,
      h("div", null, h("button", { class: "btn goud", type: "submit" }, "Opslaan")));
    const sluit = paneel(p ? `${p.serie} series · ${p.naam} (${p.code})` : "Nieuw product", f);
  }

  // ============================================================ VOORRAAD
  async function pVoorraad() {
    const d = await api("hq/voorraad");
    const t = d.totaal;
    let alleenMet = true;
    const tabel = h("div");
    const teken = () => {
      const rijen = d.producten.filter((p) => !alleenMet || p.bij_leverancier || p.in_magazijn || p.onderweg || p.in_productie || p.gereserveerd);
      tabel.replaceChildren(rijen.length ? h("div", { class: "tabelwrap" }, h("table", null,
        h("thead", null, h("tr", null, ["", "Model", "Bij leverancier", "Gereserveerd", "Vrij bij lev.", "In productie", "Onderweg", "In NL", "Waarde bij lev."].map((k, i) => h("th", { class: i > 1 ? "num" : "" }, k)))),
        h("tbody", null, rijen.map((p) => h("tr", { class: "klik", onclick: () => mutatiePaneel(p) },
          h("td", null, p.afbeelding ? h("img", { class: "thumb", src: p.afbeelding, alt: "", loading: "lazy" }) : null), h("td", null, h("b", null, `${p.serie} · ${p.naam}`), h("div", { class: "small muted" }, p.code)),
          h("td", { class: "num" }, num(p.bij_leverancier)), h("td", { class: "num" }, p.gereserveerd ? num(p.gereserveerd) : "—"), h("td", { class: "num" }, h("b", null, num(p.vrij_bij_leverancier))),
          h("td", { class: "num" }, p.in_productie ? num(p.in_productie) : "—"), h("td", { class: "num" }, p.onderweg ? num(p.onderweg) : "—"), h("td", { class: "num" }, num(p.in_magazijn)),
          h("td", { class: "num" }, p.inkoop_cents ? eur(p.bij_leverancier * p.inkoop_cents) : "—")))))) : h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, "Nog geen voorraad. Voorraad ontstaat vanzelf bij inkoop (het MOQ-overschot blijft bij de leverancier), of boek een beginvoorraad.")));
    };
    teken();
    return h("div", null,
      kop("Voorraad", "Wat er bij de leverancier ligt (o.a. het overschot boven de bestelling, door de MOQ van 50), wat er in productie en onderweg is, en wat er in Nederland ligt. Bij een nieuwe order wordt eerst de vrije voorraad bij de leverancier gebruikt.",
        h("button", { class: "btn goud", onclick: () => mutatiePaneel(null) }, "Voorraad boeken")),
      h("div", { class: "grid g6" },
        h("div", { class: "kpi donker" }, h("b", null, num(t.leverancier)), h("span", null, "bij de leverancier"), h("small", null, eur0(t.waardeLeverancier) + " inkoopwaarde")),
        h("div", { class: "kpi goed" }, h("b", null, num(t.vrij)), h("span", null, "vrij om te verkopen"), h("small", null, "direct verzendklaar (alleen vlucht)")),
        h("div", { class: "kpi" }, h("b", null, num(t.inProductie)), h("span", null, "in productie")),
        h("div", { class: "kpi" }, h("b", null, num(t.onderweg)), h("span", null, "onderweg naar NL")),
        h("div", { class: "kpi" }, h("b", null, num(t.magazijn)), h("span", null, "in Nederland"), h("small", null, eur0(t.waardeMagazijn))),
        h("div", { class: "kpi" }, h("b", null, num(d.producten.filter((p) => p.bij_leverancier > 0).length)), h("span", null, "modellen op voorraad"))),
      h("div", { class: "kaart-kop", style: { marginTop: "18px" } }, h("h2", null, "Per model"), h("label", { class: "check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { alleenMet = e.target.checked; teken(); } }), "Alleen modellen met voorraad of beweging")),
      tabel,
      h("h2", { style: { margin: "22px 0 10px" } }, "Laatste boekingen"),
      d.mutaties.length ? h("div", { class: "tabelwrap" }, h("table", null, h("thead", null, h("tr", null, ["Wanneer", "Model", "Waar", "Aantal", "Soort", "Ref / notitie"].map((k, i) => h("th", { class: i === 3 ? "num" : "" }, k)))),
        h("tbody", null, d.mutaties.map((m) => h("tr", null, h("td", { class: "small nowrap" }, tijd(m.created_at)), h("td", null, `${m.code} ${m.naam}`), h("td", null, m.locatie === "leverancier" ? "Leverancier" : "Nederland"),
          h("td", { class: "num" }, (m.aantal > 0 ? "+" : "") + m.aantal), h("td", null, m.soort), h("td", { class: "small muted" }, [m.ref, m.notitie, m.door].filter(Boolean).join(" · "))))))) : h("p", { class: "muted" }, "Nog geen boekingen."));
  }
  async function mutatiePaneel(p) {
    const producten = await productenLaden();
    const f = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); await api("hq/voorraad/mutatie", { method: "POST", body: formWaarden(f) }); sluit(); state.producten = null; route(); }, "Geboekt") },
      h("p", { class: "muted" }, "Boek voorraad bij (+) of af (−). Gebruik dit voor een beginvoorraad, een telling of een correctie. Inkoop en leveringen boeken zichzelf."),
      veld("Model", sel("product_id", producten.map((x) => [x.id, `${x.serie} series · ${prodNaam(x)}`]), p?.id)),
      h("div", { class: "rij" }, veld("Waar", sel("locatie", [["leverancier", "Bij de leverancier (China)"], ["magazijn", "In Nederland"]], "leverancier")), veld("Aantal (+ of −)", inp("aantal", "", { type: "number", required: true })), veld("Soort", sel("soort", [["beginvoorraad", "Beginvoorraad"], ["correctie", "Correctie / telling"], ["restant", "Restant bij leverancier"]], "correctie"))),
      veld("Notitie", inp("notitie")), h("div", null, h("button", { class: "btn goud", type: "submit" }, "Boeken")));
    const sluit = paneel("Voorraad boeken", f);
  }

  // ============================================================ ORDERS
  const ORDER_FILTERS = [["open", "Open"], ["besteld", "Besteld"], ["in_productie", "In productie"], ["onderweg", "Onderweg"], ["binnen", "Binnen"], ["geleverd", "Geleverd"], ["geannuleerd", "Geannuleerd"], ["", "Alle"]];
  let orderFilter = "open";
  async function pOrders() {
    const { orders } = await api("hq/orders?status=" + orderFilter);
    return h("div", null,
      kop("Orders", "Bestellingen van horecazaken. Lampen worden per order ingekocht (Inkoop): eerst uit de vrije voorraad bij de leverancier, de rest wordt geproduceerd. Productie ± 21 dagen + vlucht ± 7 dagen.", h("a", { class: "btn goud", href: "#orders/nieuw" }, "Nieuwe order")),
      h("div", { class: "chips" }, ORDER_FILTERS.map(([k, t]) => h("button", { class: "chip" + (k === orderFilter ? " on" : ""), onclick: () => { orderFilter = k; route(); } }, t))),
      orders.length ? h("div", { class: "tabelwrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Order", "Klant", "Besteld", "Lampen", "Bedrag (excl. btw)", "Status", "Verwacht", "Inkoop", "Factuur"].map((k, i) => h("th", { class: i === 3 || i === 4 ? "num" : "" }, k)))),
        h("tbody", null, orders.map((o) => h("tr", { class: "klik", onclick: () => (location.hash = "#orders/" + o.id) },
          h("td", null, h("b", null, o.nummer), o.referentie ? h("div", { class: "small muted" }, o.referentie) : null), h("td", null, o.bedrijf, h("div", { class: "small muted" }, o.plaats)),
          h("td", { class: "small nowrap" }, datum(o.besteld_op)), h("td", { class: "num" }, num(o.lampen)), h("td", { class: "num" }, eur(o.subtotaal_cents)),
          h("td", null, st(ORDER, o.status)), h("td", { class: "small nowrap" }, o.status === "geleverd" ? "geleverd " + kortDatum(o.geleverd_op) : o.leverdatum ? kortDatum(o.leverdatum) : "—"),
          h("td", { class: "small" }, o.zonder_inkoop ? h("span", { class: "st oranje" }, "nog inkopen") : o.inkoop || "—"),
          h("td", null, o.factuur_status ? st(FACT, o.factuur_status) : h("span", { class: "muted small" }, "—"))))))) : h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, "Geen orders in deze lijst.")));
  }
  function regelEditor(producten, start = []) {
    const lijst = h("div", { class: "regels" });
    const som = h("div", { class: "som" });
    const extra = { verzend: inp("verzend", "", { inputmode: "decimal", placeholder: "0,00" }), korting: inp("korting", "", { inputmode: "decimal", placeholder: "0,00" }) };
    const opties = [["", "— Kies een model of typ een omschrijving —"], ...producten.filter((p) => p.actief).map((p) => [p.id, `${p.serie} series · ${prodNaam(p)}`])];
    const herreken = () => {
      let t = 0;
      lijst.querySelectorAll(".regel").forEach((r) => { const a = Number(r.querySelector("[data-a]").value || 0), p = Math.round(Number(String(r.querySelector("[data-p]").value || "0").replace(",", ".")) * 100); r.querySelector(".tot").textContent = eur(a * p); t += a * p; });
      const v = Math.round(Number(String(extra.verzend.value || "0").replace(",", ".")) * 100), k = Math.round(Number(String(extra.korting.value || "0").replace(",", ".")) * 100);
      som.replaceChildren(h("div", null, h("span", null, "Regels"), h("span", null, eur(t))), v ? h("div", null, h("span", null, "Verzending"), h("span", null, eur(v))) : null, k ? h("div", null, h("span", null, "Korting"), h("span", null, eur(-k))) : null,
        h("div", { class: "totaal" }, h("span", null, "Totaal excl. btw"), h("span", null, eur(t + v - k))), h("div", { class: "muted" }, h("span", null, "incl. 21% btw"), h("span", null, eur(Math.round((t + v - k) * 1.21)))));
    };
    const nieuweRegel = (r = {}) => {
      const pSel = h("select", { "data-prod": "" }, opties.map(([v, t]) => h("option", { value: v, selected: String(v) === String(r.product_id || "") }, t)));
      const oms = h("input", { type: "text", "data-o": "", placeholder: "Omschrijving (bijv. laadtrolley 24 stuks)", value: r.product_id ? "" : r.omschrijving || "" });
      oms.hidden = !!r.product_id;
      const aantal = h("input", { type: "number", min: 1, "data-a": "", value: r.aantal || 1, oninput: herreken });
      const prijs = h("input", { type: "text", inputmode: "decimal", "data-p": "", value: r.prijs_cents !== undefined ? geld(r.prijs_cents) : "", placeholder: "prijs", oninput: herreken });
      pSel.addEventListener("change", () => { const p = producten.find((x) => String(x.id) === pSel.value); oms.hidden = !!p; if (p && (!prijs.value || prijs.value === "0,00")) prijs.value = geld(p.verkoop_cents); herreken(); });
      const rij = h("div", { class: "regel" }, h("div", { class: "stack" }, pSel, oms), aantal, prijs, h("div", { class: "tot" }), h("button", { type: "button", class: "x", "aria-label": "Regel weg", onclick: () => { rij.remove(); herreken(); } }, "×"));
      lijst.append(rij); herreken();
    };
    (start.length ? start : [{}]).forEach(nieuweRegel);
    extra.verzend.addEventListener("input", herreken); extra.korting.addEventListener("input", herreken);
    const waarden = () => [...lijst.querySelectorAll(".regel")].map((r) => ({ product_id: r.querySelector("[data-prod]").value || null, omschrijving: r.querySelector("[data-o]").value, aantal: r.querySelector("[data-a]").value, prijs: r.querySelector("[data-p]").value })).filter((r) => r.product_id || r.omschrijving);
    return { el: h("div", null, h("div", { class: "regel muted small" }, h("span", null, "Model / omschrijving"), h("span", null, "Aantal"), h("span", null, "Prijs p/st excl."), h("span", { class: "right" }, "Totaal"), h("span")), lijst,
      h("div", { class: "acties", style: { marginTop: "8px" } }, h("button", { type: "button", class: "btn licht klein", onclick: () => nieuweRegel() }, "+ Regel")),
      h("div", { class: "rij form", style: { marginTop: "12px" } }, veld("Verzending (excl. btw)", extra.verzend), veld("Korting (excl. btw)", extra.korting)), som), waarden, extra };
  }
  async function pOrderNieuw() {
    const [producten, { klanten }] = await Promise.all([productenLaden(true), api("hq/klanten")]);
    let voor = null; try { voor = JSON.parse(sessionStorage.getItem("lq-order-klant") || "null"); } catch {}
    const klantId = sessionStorage.getItem("lq-order-klant-id") || "";
    sessionStorage.removeItem("lq-order-klant"); sessionStorage.removeItem("lq-order-klant-id");
    const kSel = h("select", { name: "klant_id" }, h("option", { value: "" }, "+ Nieuwe klant"), klanten.map((k) => h("option", { value: k.id, selected: String(k.id) === klantId }, `${k.bedrijf}${k.plaats ? " (" + k.plaats + ")" : ""}`)));
    const nieuwK = h("div", { class: "form" },
      h("div", { class: "rij" }, veld("Naam van de zaak", inp("k_bedrijf", voor?.bedrijf)), veld("Contactpersoon", inp("k_contact", voor?.contact)), veld("E-mail (facturen)", inp("k_email", voor?.email, { type: "email" }))),
      h("div", { class: "rij" }, veld("Telefoon", inp("k_telefoon", voor?.telefoon)), veld("Adres", inp("k_adres")), veld("Postcode", inp("k_postcode")), veld("Plaats", inp("k_plaats", voor?.plaats))), veld("Btw-nummer", inp("k_btw_nummer")));
    const toon = () => { nieuwK.hidden = !!kSel.value; }; kSel.addEventListener("change", toon); toon();
    const ed = regelEditor(producten);
    const meta = h("div", { class: "rij form" }, veld("Besteldatum", inp("besteld_op", vandaag(), { type: "date" })), veld("Referentie klant", inp("referentie")), veld("Afgesproken leverdatum (optioneel)", inp("leverdatum", "", { type: "date" })));
    const notities = h("textarea", { name: "notities" });
    const opslaan = doe(async () => {
      const w = (n) => app.querySelector(`[name="${n}"]`)?.value || "";
      const body = { regels: ed.waarden(), verzend: ed.extra.verzend.value, korting: ed.extra.korting.value, besteld_op: w("besteld_op"), referentie: w("referentie"), leverdatum: w("leverdatum"), notities: notities.value, aanvraag_id: voor?.aanvraag_id || null };
      if (kSel.value) body.klant_id = kSel.value;
      else body.klant = { bedrijf: w("k_bedrijf"), contact: w("k_contact"), email: w("k_email"), telefoon: w("k_telefoon"), adres: w("k_adres"), postcode: w("k_postcode"), plaats: w("k_plaats"), btw_nummer: w("k_btw_nummer"), lead_id: voor?.lead_id || null };
      const r = await api("hq/orders", { method: "POST", body });
      location.hash = "#orders/" + r.order.id; badgesLaden();
    }, "Order aangemaakt");
    return h("div", null, h("p", null, h("a", { href: "#orders" }, "← Orders")), kop("Nieuwe order", "Prijzen zijn per stuk en exclusief btw. De verkoopprijs van het model wordt vooraf ingevuld."),
      h("div", { class: "stack" },
        h("div", { class: "kaart" }, h("h2", null, "Klant"), veld("Klant", kSel), nieuwK),
        h("div", { class: "kaart" }, h("h2", null, "Wat bestellen ze?"), ed.el),
        h("div", { class: "kaart" }, h("h2", null, "Details"), meta, veld("Notities", notities)),
        h("div", null, h("button", { class: "btn goud", onclick: opslaan }, "Order aanmaken"))));
  }
  async function pOrder(id) {
    const d = await api("hq/order/" + id);
    const o = d.order, k = d.klant;
    const volgorde = ["besteld", "in_productie", "onderweg", "binnen", "geleverd"];
    const i = volgorde.indexOf(o.status);
    const stappen = h("div", { class: "stappen" }, volgorde.map((s, j) => h("div", { class: "stap" + (o.status !== "geannuleerd" && j < i ? " klaar" : "") + (j === i ? " nu" : "") }, h("b", null, ORDER[s][0]), j === 0 ? datum(o.besteld_op) : s === "geleverd" && o.geleverd_op ? datum(o.geleverd_op) : j === 3 && o.leverdatum ? "verwacht " + kortDatum(o.leverdatum) : "")));
    const zetStatus = (s, t, cls = "licht", vraag) => h("button", { class: "btn " + cls, onclick: doe(async () => { if (vraag && !confirm(vraag)) return; await api("hq/order/" + id, { method: "POST", body: { status: s } }); route(); badgesLaden(); }, "Bijgewerkt") }, t);
    const marge = d.marge;
    const notF = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); await api("hq/order/" + id, { method: "POST", body: formWaarden(notF) }); route(); }, "Opgeslagen") },
      h("div", { class: "rij" }, veld("Referentie", inp("referentie", o.referentie)), veld("Leverdatum", inp("leverdatum", o.leverdatum || "", { type: "date" }))), veld("Notities", h("textarea", { name: "notities" }, o.notities)), h("div", null, h("button", { class: "btn", type: "submit" }, "Opslaan")));
    return h("div", null, h("p", null, h("a", { href: "#orders" }, "← Orders")),
      kop(`${o.nummer}`, `${k.bedrijf}${k.plaats ? " · " + k.plaats : ""} · besteld ${datum(o.besteld_op)}`,
        o.status === "binnen" ? zetStatus("geleverd", "Geleverd aan klant", "goud") : null,
        regelsZonderInkoop(d) ? h("a", { class: "btn goud", href: "#inkoop" }, "Inkopen") : null,
        !d.facturen.some((f) => f.status !== "gecrediteerd") && o.status !== "geannuleerd" ? h("button", { class: "btn licht", onclick: doe(async () => { const r = await api("hq/facturen", { method: "POST", body: { order_id: id } }); location.hash = "#finance"; return r; }, (r) => `Factuur ${r.factuur.nummer} gemaakt`) }, "Factuur maken") : null,
        !["geleverd", "geannuleerd"].includes(o.status) ? zetStatus("geannuleerd", "Annuleren", "rood", "Order annuleren? Regels in een inkooporder die nog niet verzonden is, worden eruit gehaald.") : null),
      o.status === "geannuleerd" ? h("div", { class: "melding fout" }, "Deze order is geannuleerd.") : stappen,
      h("div", { class: "grid g2" },
        h("div", { class: "stack" },
          h("div", { class: "kaart" }, h("h2", null, "Regels"), h("div", { class: "tabelwrap" }, h("table", null,
            h("thead", null, h("tr", null, ["", "Omschrijving", "Aantal", "Prijs", "Totaal", "Inkoop"].map((x, j) => h("th", { class: j >= 2 && j <= 4 ? "num" : "" }, x)))),
            h("tbody", null, d.regels.map((r) => h("tr", null, h("td", null, r.afbeelding ? h("img", { class: "thumb", src: r.afbeelding, alt: "" }) : null), h("td", null, r.omschrijving, r.leverancier_code ? h("div", { class: "small muted" }, "lev. " + r.leverancier_code) : null),
              h("td", { class: "num" }, r.aantal), h("td", { class: "num" }, eur(r.prijs_cents)), h("td", { class: "num" }, eur(r.aantal * r.prijs_cents)),
              h("td", { class: "small" }, !r.product_id ? "—" : r.inkoop_id ? h("a", { href: "#inkoop/" + r.inkoop_id }, r.inkoop_nummer, " ", r.uit_voorraad ? `(${r.uit_voorraad} uit voorraad)` : "") : h("span", { class: "st oranje" }, "nog inkopen"))))))),
            h("div", { class: "som" }, o.verzend_cents ? h("div", null, h("span", null, "Verzending"), h("span", null, eur(o.verzend_cents))) : null, o.korting_cents ? h("div", null, h("span", null, "Korting"), h("span", null, eur(-o.korting_cents))) : null,
              h("div", { class: "totaal" }, h("span", null, "Totaal excl. btw"), h("span", null, eur(o.subtotaal_cents))), h("div", { class: "muted" }, h("span", null, "Inkoopwaarde lampen"), h("span", null, eur(marge.inkoop_cents))), h("div", null, h("span", null, "Marge"), h("span", null, eur(marge.marge_cents))))),
          h("div", { class: "kaart" }, h("h2", null, "Notities"), notF)),
        h("div", { class: "stack" },
          h("div", { class: "kaart" }, h("div", { class: "kaart-kop" }, h("h2", null, "Klant"), h("button", { class: "btn licht klein", onclick: () => klantPaneel(k) }, "Wijzigen")), h("dl", { class: "info" },
            h("dt", null, "Zaak"), h("dd", null, k.bedrijf), h("dt", null, "Contact"), h("dd", null, k.contact || "—"), h("dt", null, "E-mail"), h("dd", null, k.email ? h("a", { href: "mailto:" + k.email }, k.email) : "—"),
            h("dt", null, "Telefoon"), h("dd", null, k.telefoon || "—"), h("dt", null, "Adres"), h("dd", null, [k.adres, [k.postcode, k.plaats].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—"))),
          h("div", { class: "kaart" }, h("h2", null, "Facturen"), d.facturen.length ? h("ul", { class: "lijst" }, d.facturen.map((f) => h("li", null, h("a", { href: `/api/hq/factuur/${f.id}/pdf`, target: "_blank", rel: "noopener" }, f.nummer), st(FACT, f.status === "open" && f.vervaldatum < vandaag() ? "vervallen" : f.status), h("span", { class: "mono" }, eur(f.totaal_cents))))) : h("p", { class: "muted" }, "Nog geen factuur.")))));
  }
  const regelsZonderInkoop = (d) => d.order.status !== "geannuleerd" && d.regels.some((r) => r.product_id && !r.inkoop_id);

  // ============================================================ INKOOP
  async function pInkoopLijst() {
    const d = await api("hq/inkoop");
    const s = d.instellingen;
    const gekozen = new Set(d.behoefte.map((b) => b.id));
    const maak = doe(async () => { const r = await api("hq/inkoop/behoefte", { method: "POST", body: { product_ids: [...gekozen] } }); location.hash = "#inkoop/" + r.inkoop.id; badgesLaden(); }, "Inkooporder (concept) gemaakt");
    const tijdlijn = (p) => {
      if (!p.besteld_op) return h("span", { class: "muted small" }, "nog niet besteld");
      const start = new Date(p.besteld_op), eind = new Date(p.binnen_verwacht || p.besteld_op), nu = new Date();
      const pr = Math.max(0, Math.min(100, ((nu - start) / Math.max(1, eind - start)) * 100));
      return h("div", null, h("div", { class: "balk" }, h("i", { style: { width: (p.status === "ontvangen" ? 100 : pr) + "%" } })), h("div", { class: "small muted" }, `${kortDatum(p.besteld_op)} → ${p.productie ? "klaar " + kortDatum(p.klaar_verwacht) + " → " : ""}binnen ${kortDatum(p.binnen_verwacht)}`));
    };
    return h("div", null,
      kop("Inkoop", `Bij de leverancier in China. Productie ± ${s.productieDagen} dagen, daarna ± ${s.verzendDagen} dagen luchtvracht. De leverancier maakt minimaal ${s.moq} stuks per model (MOQ); wat je niet verkocht hebt, blijft daar als voorraad liggen.`,
        h("a", { class: "btn licht", href: "#inkoop/nieuw" }, "Handmatige inkooporder")),
      h("div", { class: "kaart" }, h("div", { class: "kaart-kop" }, h("h2", null, "Nog in te kopen"), d.behoefte.length ? h("button", { class: "btn goud", onclick: maak }, "Inkooporder maken") : null),
        d.behoefte.length ? h("div", { class: "tabelwrap" }, h("table", null,
          h("thead", null, h("tr", null, ["", "", "Model", "Verkocht", "Vrij bij lev.", "Uit voorraad", "Produceren", "Blijft bij lev.", "Orders"].map((k, i) => h("th", { class: i >= 3 && i <= 7 ? "num" : "" }, k)))),
          h("tbody", null, d.behoefte.map((b) => h("tr", null,
            h("td", null, h("input", { type: "checkbox", checked: true, onchange: (e) => (e.target.checked ? gekozen.add(b.id) : gekozen.delete(b.id)) })),
            h("td", null, b.afbeelding ? h("img", { class: "thumb", src: b.afbeelding, alt: "" }) : null),
            h("td", null, h("b", null, `${b.serie} · ${b.naam}`), h("div", { class: "small muted" }, `${b.code}${b.leverancier_code ? " · lev. " + b.leverancier_code : ""} · MOQ ${b.moq}`)),
            h("td", { class: "num" }, b.nodig), h("td", { class: "num" }, b.vrij), h("td", { class: "num" }, b.uit_voorraad || "—"), h("td", { class: "num" }, h("b", null, b.productie || "—")),
            h("td", { class: "num" }, b.overschot ? h("span", { class: "st goud" }, `+${b.overschot}`) : "—"),
            h("td", { class: "small" }, b.orders.map((r) => h("div", null, h("a", { href: "#orders/" + r.order_id }, r.nummer), ` ${r.bedrijf} (${r.aantal})`)))))))) : h("p", { class: "muted" }, "Alles is ingekocht. Nieuwe orders verschijnen hier vanzelf.")),
      h("h2", { style: { margin: "22px 0 10px" } }, "Inkooporders"),
      d.inkooporders.length ? h("div", { class: "tabelwrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Nummer", "Status", "Produceren", "Uit voorraad", "Naar NL", "Waarde", "Planning", "Voor orders"].map((k, i) => h("th", { class: i >= 2 && i <= 5 ? "num" : "" }, k)))),
        h("tbody", null, d.inkooporders.map((p) => h("tr", { class: "klik", onclick: () => (location.hash = "#inkoop/" + p.id) },
          h("td", null, h("b", null, p.nummer), h("div", { class: "small muted" }, `${p.producten} modellen`)), h("td", null, st(PO, p.status)),
          h("td", { class: "num" }, num(p.productie_stuks)), h("td", { class: "num" }, num(p.uit_voorraad_stuks)), h("td", { class: "num" }, num(p.verzend_stuks)), h("td", { class: "num" }, eur0(p.waarde_cents)),
          h("td", { style: { minWidth: "220px" } }, tijdlijn(p)), h("td", { class: "small" }, p.orders || "voorraad")))))) : h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, "Nog geen inkooporders.")));
  }
  async function pInkoopNieuw() {
    const producten = await productenLaden(true);
    const lijst = h("div", { class: "stack" });
    const regel = () => {
      const r = h("div", { class: "rij form" }, veld("Model", sel("product_id", producten.filter((p) => p.actief).map((p) => [p.id, `${p.serie} · ${prodNaam(p)} (vrij bij lev.: ${p.vrij_bij_leverancier})`]))),
        veld("Produceren", inp("productie", "0", { type: "number", min: 0 }), "0 of minimaal de MOQ"), veld("Uit voorraad lev.", inp("uit_voorraad", "0", { type: "number", min: 0 })), veld("Naar Nederland", inp("verzenden", "", { type: "number", min: 0 }), "leeg = alles"));
      lijst.append(r);
    };
    regel();
    const notities = h("textarea", { name: "notities", placeholder: "Bijv. voorraad aanvullen voor het terrasseizoen" });
    return h("div", null, h("p", null, h("a", { href: "#inkoop" }, "← Inkoop")), kop("Handmatige inkooporder", "Voor voorraad zonder order: extra laten produceren, of lampen die bij de leverancier liggen naar Nederland halen."),
      h("div", { class: "kaart" }, lijst, h("div", { class: "acties", style: { marginTop: "10px" } }, h("button", { class: "btn licht klein", onclick: regel }, "+ Model")), veld("Notities", notities)),
      h("div", { style: { marginTop: "14px" } }, h("button", { class: "btn goud", onclick: doe(async () => {
        const regels = [...lijst.children].map((r) => ({ product_id: r.querySelector("[name=product_id]").value, productie: r.querySelector("[name=productie]").value, uit_voorraad: r.querySelector("[name=uit_voorraad]").value, verzenden: r.querySelector("[name=verzenden]").value }));
        const res = await api("hq/inkoop", { method: "POST", body: { regels, notities: notities.value } }); location.hash = "#inkoop/" + res.inkoop.id;
      }, "Inkooporder gemaakt") }, "Inkooporder maken (concept)")));
  }
  async function pInkoop(id) {
    const d = await api("hq/inkoop/" + id);
    const p = d.inkoop;
    const concept = p.status === "concept";
    const datumIn = h("input", { type: "date", value: vandaag() });
    const zet = (s, t, cls = "goud", vraag) => h("button", { class: "btn " + cls, onclick: doe(async () => { if (vraag && !confirm(vraag)) return; await api(`hq/inkoop/${id}/status`, { method: "POST", body: { status: s, datum: datumIn.value } }); route(); badgesLaden(); }, "Bijgewerkt") }, t);
    const volgende = { concept: [zet("besteld", "Besteld bij leverancier")], besteld: [zet("in_productie", "In productie", "licht"), zet("verzonden", "Verzonden (vlucht)")], in_productie: [zet("verzonden", "Verzonden (vlucht)")], verzonden: [zet("ontvangen", "Ontvangen in NL")] }[p.status] || [];
    const annuleer = ["concept", "besteld", "in_productie"].includes(p.status) ? zet("geannuleerd", "Annuleren", "rood", "Inkooporder annuleren? De orders komen terug bij \"Nog in te kopen\".") : null;
    const stappen = ["besteld", "in_productie", "verzonden", "ontvangen"];
    const i = stappen.indexOf(p.status);
    const regelInputs = new Map();
    const tabel = h("div", { class: "tabelwrap" }, h("table", null,
      h("thead", null, h("tr", null, ["", "Model", "Lev. nr.", "Verkocht", "Produceren", "Uit voorraad", "Naar NL", "Blijft bij lev.", "Inkoop p/st"].map((k, j) => h("th", { class: j >= 3 ? "num" : "" }, k)))),
      h("tbody", null, d.regels.map((r) => {
        const cel = (k, v) => { if (!concept) return v; const el = h("input", { type: k === "prijs" ? "text" : "number", min: 0, value: k === "prijs" ? geld(v) : v, style: { width: "90px", textAlign: "right" } }); regelInputs.set(`${r.product_id}:${k}`, el); return el; };
        return h("tr", null, h("td", null, r.afbeelding ? h("img", { class: "thumb", src: r.afbeelding, alt: "" }) : null), h("td", null, h("b", null, `${r.serie} · ${r.naam}`), h("div", { class: "small muted" }, `${r.code} · MOQ ${r.moq}`)),
          h("td", null, r.leverancier_code || "—"), h("td", { class: "num" }, r.voor_orders), h("td", { class: "num" }, cel("productie", r.productie)), h("td", { class: "num" }, cel("uit_voorraad", r.uit_voorraad)),
          h("td", { class: "num" }, cel("verzenden", r.verzenden)), h("td", { class: "num" }, r.blijft > 0 ? h("span", { class: "st goud" }, `+${r.blijft}`) : "—"), h("td", { class: "num" }, concept ? cel("prijs", r.prijs_cents) : eur(r.prijs_cents)));
      }))));
    const waarde = d.regels.reduce((t, r) => t + r.productie * r.prijs_cents, 0) + p.vrachtkosten_cents;
    const meta = h("form", { class: "form", onsubmit: doe(async (e) => { e.preventDefault(); await api("hq/inkoop/" + id, { method: "POST", body: formWaarden(meta) }); route(); }, "Opgeslagen") },
      h("div", { class: "rij" }, veld("Leverancier", inp("leverancier", p.leverancier)), veld("Productiedagen", inp("productie_dagen", p.productie_dagen, { type: "number", min: 0 })), veld("Vluchtdagen", inp("verzend_dagen", p.verzend_dagen, { type: "number", min: 0 }))),
      h("div", { class: "rij" }, veld("Vrachtkosten (excl. btw)", inp("vracht", geld(p.vrachtkosten_cents), { inputmode: "decimal" })), veld("Tracking / AWB", inp("tracking", p.tracking))),
      veld("Notities", h("textarea", { name: "notities" }, p.notities)), h("div", null, h("button", { class: "btn", type: "submit" }, "Opslaan")));
    const lijstTekst = h("pre", { class: "mail" }, d.bestellijst);
    return h("div", null, h("p", null, h("a", { href: "#inkoop" }, "← Inkoop")),
      kop(p.nummer, `${p.leverancier} · ${p.productie ? "productie + luchtvracht" : "alleen luchtvracht uit voorraad"}`, volgende.length ? h("label", { class: "veld" }, h("span", null, "Datum"), datumIn) : null, ...volgende, annuleer),
      p.status === "geannuleerd" ? h("div", { class: "melding fout" }, "Deze inkooporder is geannuleerd.") : h("div", { class: "stappen" }, stappen.map((s, j) => h("div", { class: "stap" + (j < i ? " klaar" : "") + (j === i ? " nu" : "") }, h("b", null, PO[s][0]),
        s === "besteld" ? (p.besteld_op ? datum(p.besteld_op) : "nog niet") : s === "in_productie" ? (p.klaar_verwacht ? "klaar ± " + kortDatum(p.klaar_verwacht) : "") : s === "verzonden" ? (p.verzonden_op ? datum(p.verzonden_op) : "") : p.ontvangen_op ? datum(p.ontvangen_op) : p.binnen_verwacht ? "verwacht " + kortDatum(p.binnen_verwacht) : ""))),
      concept ? h("div", { class: "melding info" }, "Concept: controleer de aantallen, stuur de bestellijst naar de leverancier en klik dan op \"Besteld bij leverancier\". Daarmee start de planning (productie + vlucht).") : null,
      h("div", { class: "kaart" }, h("div", { class: "kaart-kop" }, h("h2", null, "Regels"), h("span", { class: "mono" }, `Inkoopwaarde ${eur(waarde)}`)), tabel,
        concept ? h("div", { class: "acties", style: { marginTop: "10px" } }, h("button", { class: "btn", onclick: doe(async () => {
          const regels = d.regels.map((r) => ({ product_id: r.product_id, productie: regelInputs.get(`${r.product_id}:productie`).value, uit_voorraad: regelInputs.get(`${r.product_id}:uit_voorraad`).value, verzenden: regelInputs.get(`${r.product_id}:verzenden`).value, prijs: regelInputs.get(`${r.product_id}:prijs`).value }));
          await api("hq/inkoop/" + id, { method: "POST", body: { regels } }); route();
        }, "Aantallen opgeslagen") }, "Aantallen opslaan"), h("span", { class: "hint" }, "Produceren: 0 of minimaal de MOQ. Naar NL: minimaal wat verkocht is.")) : null),
      h("div", { class: "grid g2", style: { marginTop: "14px" } },
        h("div", { class: "kaart" }, h("div", { class: "kaart-kop" }, h("h2", null, "Bestellijst voor de leverancier"), h("button", { class: "btn licht klein", onclick: doe(() => navigator.clipboard.writeText(d.bestellijst), "Gekopieerd") }, "Kopiëren")), lijstTekst,
          d.orders.length ? h("p", { class: "small", style: { marginTop: "10px" } }, "Voor orders: ", d.orders.map((o, j) => [j ? ", " : "", h("a", { href: "#orders/" + o.id }, o.nummer), ` (${o.bedrijf})`])) : h("p", { class: "small muted" }, "Voorraadinkoop, niet voor een order.")),
        h("div", { class: "kaart" }, h("h2", null, "Gegevens"), meta)));
  }

  // ============================================================ FINANCE
  async function pFinance() {
    const d = await api("hq/finance");
    const t = d.totaal;
    const actie = (f, a, tekst, cls = "licht", vraag) => h("button", { class: `btn klein ${cls}`, onclick: doe(async (e) => { e.stopPropagation(); if (vraag && !confirm(vraag)) return; await api("hq/factuur/" + f.id, { method: "POST", body: { actie: a } }); route(); badgesLaden(); }, "Bijgewerkt") }, tekst);
    return h("div", null,
      kop("Finance", "Facturen per order (PDF, per mail met de factuur als bijlage), wat er openstaat en wat er binnenkomt. Herinneringen gaan automatisch 7 dagen na de vervaldatum (instelbaar).", h("button", { class: "btn licht", onclick: losseFactuur }, "Losse factuur")),
      h("div", { class: "grid g5" },
        h("div", { class: "kpi donker" }, h("b", null, eur0(t.openstaand)), h("span", null, "openstaand (incl. btw)"), h("small", null, `${t.open_n} facturen`)),
        h("div", { class: "kpi " + (t.vervallen_n ? "let" : "") }, h("b", null, eur0(t.vervallen)), h("span", null, "over de vervaldatum"), h("small", null, `${t.vervallen_n} facturen`)),
        h("div", { class: "kpi" }, h("b", null, eur0(t.omzet_maand)), h("span", null, "omzet deze maand"), h("small", null, "excl. btw, gefactureerd")),
        h("div", { class: "kpi goed" }, h("b", null, eur0(t.ontvangen_maand)), h("span", null, "ontvangen deze maand")),
        h("div", { class: "kpi" }, h("b", null, eur0(t.omzet_jaar)), h("span", null, "omzet dit jaar"), h("small", null, "excl. btw"))),
      d.teFactureren.length ? h("div", { class: "kaart", style: { marginTop: "14px" } }, h("h2", null, "Nog te factureren"), h("ul", { class: "lijst" }, d.teFactureren.map((o) => h("li", null, h("span", null, h("a", { href: "#orders/" + o.id }, o.nummer), ` · ${o.bedrijf} · `, st(ORDER, o.status)), h("span", { class: "acties" }, h("span", { class: "mono" }, eur(o.subtotaal_cents)),
        h("button", { class: "btn klein goud", onclick: doe(async () => { await api("hq/facturen", { method: "POST", body: { order_id: o.id } }); route(); }, "Factuur gemaakt") }, "Factuur maken")))))) : null,
      h("div", { class: "kaart", style: { marginTop: "14px" } }, h("h2", null, "Omzet en inkoop per maand"),
        grafiek(d.maanden, [{ k: "omzet", t: "Omzet (excl. btw)", c: "a", kleur: "#1a1612", fmt: eur0 }, { k: "inkoop", t: "Inkoop bij leverancier", c: "b", kleur: "#c9a15c", fmt: eur0 }, { k: "ontvangen", t: "Ontvangen", c: "c", kleur: "#cbbfa9", fmt: eur0 }], (r) => r.maand.slice(5) + "/" + r.maand.slice(2, 4))),
      h("h2", { style: { margin: "22px 0 10px" } }, "Facturen"),
      d.facturen.length ? h("div", { class: "tabelwrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Nummer", "Klant", "Datum", "Vervalt", "Bedrag", "Status", ""].map((k, i) => h("th", { class: i === 4 ? "num" : "" }, k)))),
        h("tbody", null, d.facturen.map((f) => h("tr", null,
          h("td", null, h("a", { href: `/api/hq/factuur/${f.id}/pdf`, target: "_blank", rel: "noopener" }, h("b", null, f.nummer)), f.order_nummer ? h("div", { class: "small" }, h("a", { href: "#orders/" + f.order_id }, f.order_nummer)) : null),
          h("td", null, f.bedrijf), h("td", { class: "small nowrap" }, datum(f.factuurdatum)), h("td", { class: "small nowrap" }, datum(f.vervaldatum)), h("td", { class: "num" }, eur(f.totaal_cents)),
          h("td", null, st(FACT, f.vervallen ? "vervallen" : f.status), h("div", { class: "small muted" }, f.status === "betaald" ? "op " + kortDatum(f.betaald_op) : f.verzonden_at ? "verstuurd " + kortDatum(f.verzonden_at) + (f.herinneringen ? ` · ${f.herinneringen}× herinnerd` : "") : "nog niet verstuurd")),
          h("td", null, h("div", { class: "acties" },
            h("a", { class: "btn klein licht", href: `/api/hq/factuur/${f.id}/pdf`, target: "_blank", rel: "noopener" }, "PDF"),
            f.status === "open" ? actie(f, f.verzonden_at ? (f.vervallen ? "herinnering" : "verstuur") : "verstuur", f.verzonden_at ? (f.vervallen ? "Herinnering" : "Opnieuw sturen") : "Versturen", f.verzonden_at ? "licht" : "goud", `Factuur mailen naar ${f.email || "de klant"}?`) : null,
            f.status === "open" ? actie(f, "betaald", "Betaald") : null, f.status === "betaald" ? actie(f, "open", "Toch open") : null,
            f.status !== "gecrediteerd" ? actie(f, "crediteer", "Crediteren", "rood", "Factuur crediteren? Hij telt dan niet meer mee in de omzet.") : null))))))) : h("div", { class: "tabelwrap" }, h("p", { class: "leeg" }, "Nog geen facturen.")));
  }
  async function losseFactuur() {
    const { klanten } = await api("hq/klanten");
    if (!klanten.length) return toast("Maak eerst een klant aan.", true);
    const ed = regelEditor([], [{ omschrijving: "" }]);
    const kSel = sel("klant_id", klanten.map((k) => [k.id, k.bedrijf]));
    const oms = inp("omschrijving", "", { placeholder: "Betreft" });
    const sluit = paneel("Losse factuur", h("div", { class: "form" }, veld("Klant", kSel), veld("Omschrijving", oms), ed.el,
      h("div", null, h("button", { class: "btn goud", onclick: doe(async () => { await api("hq/facturen", { method: "POST", body: { klant_id: kSel.value, omschrijving: oms.value, regels: ed.waarden() } }); sluit(); route(); }, "Factuur gemaakt") }, "Factuur maken"))));
  }

  // ============================================================ INSTELLINGEN
  async function pInstellingen(tab) {
    const d = await api("hq/instellingen");
    const s = d.instellingen, k = d.koppelingen;
    const tabs = [["bedrijf", "Bedrijf"], ["b2b", "B2B-mail"], ["scout", "Scout"], ["inkoop", "Inkoop"], ["finance", "Finance"], ["koppelingen", "Koppelingen"]];
    const bewaar = (sleutel, maak) => doe(async (e) => { e.preventDefault(); await api("hq/instellingen", { method: "POST", body: { sleutel, waarde: maak() } }); }, "Opgeslagen");
    let inhoud;
    if (tab === "bedrijf") {
      const f = h("form", { class: "form" });
      const co = s.company;
      f.append(h("div", { class: "rij" }, veld("Handelsnaam", inp("name", co.name)), veld("Juridische naam", inp("legalName", co.legalName))),
        h("div", { class: "rij" }, veld("Adres", inp("address", co.address)), veld("Postcode", inp("postcode", co.postcode)), veld("Plaats", inp("city", co.city))),
        h("div", { class: "rij" }, veld("KvK", inp("kvk", co.kvk)), veld("Btw-nummer", inp("vat", co.vat)), veld("IBAN", inp("iban", co.iban), "Staat op de facturen.")),
        h("div", { class: "rij" }, veld("E-mail", inp("email", co.email, { type: "email" })), veld("Telefoon", inp("phone", co.phone)), veld("Website", inp("website", co.website))),
        h("div", { class: "rij" }, veld("Meldingen naar", inp("notify", s.notify.email, { type: "email", placeholder: "leeg = afzendadres" }), "Nieuwe aanvragen, catalogus geopend, reacties."), veld("Catalogus (pad op de site)", inp("catalogus", s.catalogus.url))),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "melding", checked: s.catalogus.melding !== false }), "Mail mij bij elke catalogusaanvraag (een demo-aanvraag meldt altijd)"),
        h("div", null, h("button", { class: "btn goud", type: "submit" }, "Opslaan")));
      f.addEventListener("submit", doe(async (e) => {
        e.preventDefault(); const w = formWaarden(f);
        await api("hq/instellingen", { method: "POST", body: { sleutel: "company", waarde: { name: w.name, legalName: w.legalName, address: w.address, postcode: w.postcode, city: w.city, kvk: w.kvk, vat: w.vat, iban: w.iban, email: w.email, phone: w.phone, website: w.website } } });
        await api("hq/instellingen", { method: "POST", body: { sleutel: "notify", waarde: { email: w.notify } } });
        await api("hq/instellingen", { method: "POST", body: { sleutel: "catalogus", waarde: { url: w.catalogus, melding: w.melding } } });
      }, "Opgeslagen"));
      inhoud = h("div", { class: "kaart" }, h("h2", null, "Bedrijfsgegevens"), h("p", { class: "muted" }, "Staan op facturen en onder mails."), f);
    } else if (tab === "b2b") {
      const b = s.b2b, t = b.templates;
      const f = h("form", { class: "form" },
        h("div", { class: "rij" }, veld("Naam afzender", inp("senderName", b.senderName)), veld("Functie", inp("senderRole", b.senderRole)), veld("Mailadres afzender", inp("senderEmail", b.senderEmail, { type: "email" }), "Verzonden via B2B_MAIL_USER in Netlify."), veld("Max. mails per dag", inp("dailyMax", b.dailyMax, { type: "number", min: 0 }), "Rustig opbouwen: 20 → 35 → 50.")),
        veld("Handtekening (afbeelding onder de mail)", inp("handtekening", b.handtekening, { placeholder: "/assets/mail/handtekening-armand.png" }), "Leeg = alleen tekst. Komt op de plek van {afzender}."),
        b.handtekening ? h("img", { src: b.handtekening, alt: "Handtekening", class: "sig-voorbeeld" }) : null,
        h("div", { class: "rij" }, veld("Versturen vanaf (uur)", inp("van", b.sendHours[0], { type: "number", min: 0, max: 23 })), veld("tot (uur)", inp("tot", b.sendHours[1], { type: "number", min: 1, max: 24 })), veld("Max. per uur (0 = automatisch)", inp("perUur", b.perUur, { type: "number", min: 0 })), veld("Opvolgen na (dagen)", inp("followupDays", b.followupDays, { type: "number", min: 1 }))),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "autoGoedkeuren", checked: b.autoGoedkeuren }), "Automatisch goedkeuren: nieuwe leads en opvolgmails gaan zonder controle de deur uit"),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "ai", checked: b.ai?.research !== false }), "Persoonlijke openingszin laten schrijven op basis van hun website (AI)"),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "opens", checked: b.meten?.opens !== false }), "Openen meten (onzichtbaar plaatje)"),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "kliks", checked: b.meten?.kliks !== false }), "Kliks meten (ook op de catalogus)"),
        h("h3", { style: { marginTop: "10px" } }, "Mailteksten"),
        h("p", { class: "hint" }, "Te gebruiken: {bedrijf}, {plaats}, {intro} (persoonlijke zin), {catalogus} (wordt een knop), {afzender} (naam + Lumiq + telefoon), {telefoon}. De afmeldlink komt er automatisch onder."),
        veld("Eerste mail: onderwerp", inp("s1", t.eerste.subject)), veld("Eerste mail: tekst", h("textarea", { name: "b1", class: "groot" }, t.eerste.body)),
        veld("Opvolgmail: onderwerp", inp("s2", t.opvolging.subject)), veld("Opvolgmail: tekst", h("textarea", { name: "b2", class: "groot" }, t.opvolging.body)),
        h("div", { class: "acties" }, h("button", { class: "btn goud", type: "submit" }, "Opslaan"),
          h("button", { class: "btn licht", type: "button", onclick: doe(() => api("hq/b2b/test", { method: "POST", body: { kind: "eerste" } }), (r) => `Testmail naar ${r.aan}`) }, "Test eerste mail naar mij"),
          h("button", { class: "btn licht", type: "button", onclick: doe(() => api("hq/b2b/test", { method: "POST", body: { kind: "opvolging" } }), (r) => `Testmail naar ${r.aan}`) }, "Test opvolgmail")));
      f.addEventListener("submit", bewaar("b2b", () => { const w = formWaarden(f); return { senderName: w.senderName, senderRole: w.senderRole, senderEmail: w.senderEmail, handtekening: w.handtekening, dailyMax: Number(w.dailyMax), perUur: Number(w.perUur), sendHours: [Number(w.van), Number(w.tot)], followupDays: Number(w.followupDays), autoGoedkeuren: w.autoGoedkeuren, ai: { research: w.ai }, meten: { opens: w.opens, kliks: w.kliks }, templates: { eerste: { subject: w.s1, body: w.b1 }, opvolging: { subject: w.s2, body: w.b2 } } }; }));
      inhoud = h("div", { class: "kaart" }, h("h2", null, "B2B-mail"), f);
    } else if (tab === "scout") {
      const sc = s.b2b.scout;
      const f = h("form", { class: "form" },
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "active", checked: sc.active }), "Elke werkdag automatisch nieuwe horecazaken zoeken (vanaf 7:00)"),
        h("div", { class: "rij" }, veld("Soorten zaken (één per regel)", h("textarea", { name: "categories", class: "groot" }, sc.categories.join("\n")), "Ideeën: " + d.horeca.join(", ")), veld("Plaatsen (één per regel)", h("textarea", { name: "places", class: "groot" }, sc.places.join("\n")), "Elke dag de volgende plaats per soort.")),
        veld("Ongeveer zoveel zaken per dag", inp("perDay", sc.perDay, { type: "number", min: 5 })),
        h("p", { class: "hint" }, "Ketens (fastfood, bezorging) en zaken zonder eigen website worden overgeslagen. De research zoekt per zaak een algemeen mailadres (info@, reserveren@, events@) en controleert of het domein mail ontvangt."),
        h("div", null, h("button", { class: "btn goud", type: "submit" }, "Opslaan")));
      f.addEventListener("submit", bewaar("b2b", () => { const w = formWaarden(f); const lijst = (x) => x.split("\n").map((y) => y.trim()).filter(Boolean); return { scout: { active: w.active, categories: lijst(w.categories), places: lijst(w.places), perDay: Number(w.perDay) } }; }));
      inhoud = h("div", { class: "kaart" }, h("h2", null, "Scout (Outscraper / Google Maps)"), !k.scout ? h("div", { class: "melding let" }, "OUTSCRAPER_API_KEY staat nog niet in Netlify.") : null, f);
    } else if (tab === "inkoop") {
      const ik = s.inkoop;
      const f = h("form", { class: "form" },
        h("div", { class: "rij" }, veld("Leverancier", inp("leverancier", ik.leverancier)), veld("Productietijd (dagen)", inp("productieDagen", ik.productieDagen, { type: "number", min: 0 })), veld("Luchtvracht (dagen)", inp("verzendDagen", ik.verzendDagen, { type: "number", min: 0 })), veld("Standaard MOQ", inp("moq", ik.moq, { type: "number", min: 1 }), "Per model aan te passen bij Producten.")),
        h("div", null, h("button", { class: "btn goud", type: "submit" }, "Opslaan")));
      f.addEventListener("submit", bewaar("inkoop", () => { const w = formWaarden(f); return { leverancier: w.leverancier, productieDagen: Number(w.productieDagen), verzendDagen: Number(w.verzendDagen), moq: Number(w.moq) }; }));
      inhoud = h("div", { class: "kaart" }, h("h2", null, "Inkoop"), f);
    } else if (tab === "finance") {
      const fi = s.finance;
      const f = h("form", { class: "form" },
        h("div", { class: "rij" }, veld("Btw-tarief (%)", inp("vatRate", fi.vatRate, { type: "number", min: 0 })), veld("Betaaltermijn (dagen)", inp("paymentTermDays", fi.paymentTermDays, { type: "number", min: 0 })), veld("Factuurprefix", inp("invoicePrefix", fi.invoicePrefix)), veld("Herinnering na (dagen over vervaldatum)", inp("reminderDays", fi.reminderDays, { type: "number", min: 1 }))),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "autoReminders", checked: fi.autoReminders }), "Automatisch herinneringen sturen (maximaal 2 per factuur)"),
        h("div", null, h("button", { class: "btn goud", type: "submit" }, "Opslaan")));
      f.addEventListener("submit", bewaar("finance", () => { const w = formWaarden(f); return { vatRate: Number(w.vatRate), paymentTermDays: Number(w.paymentTermDays), invoicePrefix: w.invoicePrefix, reminderDays: Number(w.reminderDays), autoReminders: w.autoReminders }; }));
      inhoud = h("div", { class: "kaart" }, h("h2", null, "Finance"), f);
    } else {
      const rij = (ok, t, uitleg) => h("li", null, h("span", null, h("b", null, t), h("div", { class: "small muted" }, uitleg)), h("span", { class: "st " + (ok ? "groen" : "oranje") }, ok ? "Werkt" : "Nog instellen"));
      inhoud = h("div", { class: "kaart" }, h("h2", null, "Koppelingen"), h("ul", { class: "lijst" },
        rij(k.mail, "Mail (info@lumiqstore.eu)", "MAIL_USER + MAIL_PASSWORD in Netlify. Inloggen, catalogus, facturen en meldingen."),
        rij(!!k.b2bMail, `B2B-mailbox${k.b2bMail ? " (" + k.b2bMail + ")" : ""}`, k.b2bMail ? "De B2B-mails gaan hieruit en reacties worden in deze inbox gelezen." : "B2B_MAIL_USER + B2B_MAIL_PASSWORD in Netlify (armand@lumiqstore.com). Tot die tijd gaan de B2B-mails via info@."),
        rij(k.scout, "Scout (Outscraper)", "OUTSCRAPER_API_KEY in Netlify. Zoekt horecazaken via Google Maps."),
        rij(k.ai, "AI-openingszin", "ANTHROPIC_API_KEY (of Netlify AI Gateway). Optioneel."),
        rij(k.toegang.length > 0, "Toegang tot HQ", k.toegang.join(", ") || "Zet ADMIN_EMAILS / HQ_ALLEEN in Netlify.")),
        d.inbox ? h("p", { class: "small muted" }, `Inbox laatst gelezen ${tijd(d.inbox.at)}${d.inbox.error ? " · " + d.inbox.error : ""}`) : null);
    }
    return h("div", null, kop("Instellingen", "Wijzigingen gelden direct voor de website, HQ en de mails."), h("div", { class: "tabs" }, tabs.map(([k2, t]) => h("a", { href: "#instellingen/" + k2, class: tab === k2 ? "on" : "" }, t))), inhoud);
  }

  // ============================================================ LOGBOEK
  async function pLogboek() {
    const { logboek } = await api("hq/logboek");
    return h("div", null, kop("Logboek", "Verstuurde mails en acties in HQ."),
      h("div", { class: "tabelwrap" }, h("table", null, h("thead", null, h("tr", null, ["Wanneer", "Soort", "Wat", "Details"].map((k) => h("th", null, k)))),
        h("tbody", null, logboek.map((r) => h("tr", null, h("td", { class: "small nowrap" }, tijd(r.created_at)), h("td", null, h("span", { class: "st " + (r.soort === "mail" ? "blauw" : "grijs") }, r.soort)), h("td", null, r.wat), h("td", { class: "small muted" }, String(r.detail || "").slice(0, 160))))))));
  }

  // ------------------------------------------------------------ start
  async function start() {
    try { const me = await api("auth/me"); state.user = me.user; } catch {}
    if (!state.user) return renderLogin();
    await badgesLaden();
    route();
  }
  start();
})();
