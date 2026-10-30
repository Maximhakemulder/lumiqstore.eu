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
- **Finance** (`finance.mjs`): factuur per order (21% btw, LQ-JJJJ-NNNN, PDF via pdf-lib, mailen met bijlage), betaald/open/crediteren, automatische herinneringen (max 2).

## Env-variabelen (Netlify)
MAIL_USER / MAIL_PASSWORD (info@lumiqstore.eu, Hostnet SMTP/IMAP: inloggen, catalogus, facturen, meldingen), B2B_MAIL_USER / B2B_MAIL_PASSWORD (armand@lumiqstore.com: B2B-mails + inbox-scan; optioneel B2B_SMTP_HOST/_PORT en B2B_IMAP_HOST/_PORT, standaard dezelfde server; zonder B2B_MAIL_* valt B2B terug op info@), ADMIN_EMAILS, HQ_ALLEEN (wie mag inloggen), AUTH_SECRET, PUBLIC_BASE_URL (https://lumiqstore.com), OUTSCRAPER_API_KEY, optioneel ANTHROPIC_API_KEY + AI_MODEL_LICHT, NOTIFY_EMAIL.

## Werkwijze
- Lokaal: `npm install`, `npm run dev` (PGlite, mails + inlogcode in de console), `npm test` (integratietests, moeten slagen).
- Commits op naam van Maximhakemulder (267295406+Maximhakemulder@users.noreply.github.com). Werk via branch + pull request; Maxim merget.
