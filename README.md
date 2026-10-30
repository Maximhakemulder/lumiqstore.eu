# Lumiq — website + Lumiq HQ

Website (lumiqstore.com) en het interne HQ op `/hq`: B2B-mailmachine voor de horeca, catalogusaanvragen, orders, inkoop (MOQ 50, productie 21 d + vlucht 7 d), voorraad bij de leverancier, producten en facturen.

## Lokaal
```
npm install
npm run dev     # http://localhost:8888  · HQ: /hq  · inlogcode verschijnt in de console
npm test
```

## Live zetten (eenmalig)
1. Netlify › harmonious-sprite-9900e6 › Project configuration › Build & deploy › Link repository → `Maximhakemulder/lumiqstore.eu` (branch `main`, publish `public`, build command leeg).
2. Netlify › Database (Extensions › Netlify Database) aanzetten. De migraties draaien bij de deploy.
3. Environment variables: zie CLAUDE.md.
