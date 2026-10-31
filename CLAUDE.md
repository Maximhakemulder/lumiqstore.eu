# Lumiq — website + Lumiq HQ — notities voor Claude

Eigenaar: Maxim (Gosmart B.V.). Communiceer in het Nederlands, kort en concreet.
Lumiq verkoopt draadloze, oplaadbare tafellampen B2B aan de horeca (restaurants, hotels, beach clubs/terrassen, bars/cafés). Dropship/inkoop bij een Chinese leverancier.

## Wat het is
Eén Netlify-project (`harmonious-sprite-9900e6`, domein lumiqstore.com):
- `public/` = de website (index.html, collectie in `const SERIES`, catalogus `public/brochure/lumiq-catalogus.pdf`).
- `public/hq/` = Lumiq HQ (vanilla JS, `hq.js` + `hq.css`, strikte CSP: geen inline scripts/style-attributen, alleen `el.style.x` via CSSOM; tekst altijd via textContent).
- `netlify/functions/api.mjs` (`/api/*`) en `tick.mjs` (elke 5 min). Logica in `netlify/lib/*.mjs`. Houd een tick-ronde onder ~13 s.
- Database: Netlify Database (Postgres) via `@netlify/database`, migraties in `netlify/database/migrations` (nooit een bestaande migratie wijzigen, altijd een nieuwe toevoegen).

## Afdelingen in HQ
- **B2B Verkoop** (`b2b.mjs`, `b2bstats.mjs`): scout (Outscraper) → research (algemeen mailadres + MX + AI-openingszin) → goedkeuren → mailer (daglimiet, werkdagen, verzenduren) → opvolgmail → inbox-scan (reacties/bounces) → afmelden. Klik op de catalogus in de mail = status `interesse` + melding.
- B2B-handtekening: afbeelding `public/assets/mail/handtekening-armand.png` (instelling `b2b.handtekening`), vervangt `{afzender}` in de HTML-mail; de tekstversie houdt de afzenderregels.
- **Catalogus & aanvragen** (`catalogus.mjs`): websiteformulieren (`/api/catalogus`, `/api/offerte`, ook zonder JS). Aanvrager krijgt een getelde downloadlink (`/api/catalogus/download?t=`).
- **Orders / Inkoop / Voorraad / Producten** (`handel.mjs`, `voorraad.mjs`): MOQ per model (standaard 50). Behoefte = orderregels zonder inkooporder; eerst vrije voorraad bij de leverancier, anders produceren max(MOQ, nodig); het overschot blijft bij de leverancier (voorraad locatie `leverancier`). Productie 21 dagen + vlucht 7 dagen. Voorraad = som van `voorraad_mutaties`.
- **Team & taken** (`team.mjs`, `ai.mjs`, tabel `team_vragen`/`team_briefings`/`team_taken`): per afdeling een AI-medewerker met een echt persoon (Vera directie + Daan B2B + Noor aanvragen + Ruben inkoop + Lotte orders + Bram finance; Armand doet verkoop en inkoop, Maxim directie en finance; aan te passen via settings `team`). Vragen: `/api/hq/team/vraag` (direct, anders `tick`), antwoord alleen op basis van `stand(afdeling)`. Werkdagen 7:30 ochtendbriefing van Vera (AI, of uit de cijfers zonder AI) + mail naar Maxim en Armand. Takenlijst = vaste routine (alleen als er iets te doen is) + extra taken uit de briefing, afvinken gedeeld.
- **Finance** (`finance.mjs`): factuur per order (21% btw, LQ-JJJJ-NNNN, PDF via pdf-lib, mailen met bijlage), betaald/open/crediteren, automatische herinneringen (max 2).

## Env-variabelen (Netlify)
MAIL_USER / MAIL_PASSWORD (armand@lumiqstore.com, Hostnet SMTP/IMAP: alles, keuze Maxim 31-10-2026: inloggen, catalogus, facturen, meldingen, B2B), optioneel B2B_MAIL_USER / B2B_MAIL_PASSWORD voor een aparte B2B-mailbox (+ B2B_SMTP_HOST/_PORT, B2B_IMAP_HOST/_PORT); lumiqstore.eu en info@lumiqstore.eu worden niet meer gebruikt, ADMIN_EMAILS, HQ_ALLEEN (wie mag inloggen), AUTH_SECRET, PUBLIC_BASE_URL (https://lumiqstore.com), OUTSCRAPER_API_KEY, AI via de Netlify AI Gateway (ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY door Netlify gezet; AI_MODEL standaard claude-sonnet-5-5, AI_MODEL_LICHT claude-haiku-5-5), HQ_CODE (vaste inlogcode, 6 cijfers; leeg = code per mail), NOTIFY_EMAIL.

## Werkwijze
- Lokaal: `npm install`, `npm run dev` (PGlite, mails + inlogcode in de console), `npm test` (integratietests, moeten slagen).
- Commits op naam van Maximhakemulder (267295406+Maximhakemulder@users.noreply.github.com). Werk via branch + pull request; Maxim merget.
