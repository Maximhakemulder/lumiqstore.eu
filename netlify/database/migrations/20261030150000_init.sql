-- Lumiq HQ: basis-schema. Bedragen in centen (integer), tijden als timestamptz (UTC), datums als DATE.

-- ------------------------------------------------------------------ inloggen
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  -- medewerker | admin
  role          TEXT NOT NULL DEFAULT 'medewerker',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_role_check CHECK (role IN ('medewerker','admin'))
);
CREATE TABLE login_codes (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX login_codes_email_idx ON login_codes(email, created_at DESC);
CREATE INDEX login_codes_ip_idx ON login_codes(ip, created_at DESC);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------ algemeen
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE audit_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_created_idx ON audit_log(created_at DESC);
CREATE TABLE locks (name TEXT PRIMARY KEY, until TIMESTAMPTZ NOT NULL);
CREATE TABLE mail_log (
  id         SERIAL PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ok         BOOLEAN NOT NULL,
  error      TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX mail_log_created_idx ON mail_log(created_at DESC);
CREATE INDEX mail_log_ref_idx ON mail_log(ref, kind);

-- ------------------------------------------------------------------ B2B: horecazaken die we mailen
CREATE TABLE leads (
  id            SERIAL PRIMARY KEY,
  company       TEXT NOT NULL,
  email         TEXT,
  website       TEXT NOT NULL DEFAULT '',
  domain        TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  -- scout | handmatig | import | website
  source        TEXT NOT NULL DEFAULT 'handmatig',
  -- kandidaat | nieuw | goedgekeurd | verstuurd | opvolging_goedgekeurd | opgevolgd | interesse | reactie | afspraak | klant | afgemeld | overgeslagen | fout
  status        TEXT NOT NULL DEFAULT 'nieuw',
  intro         TEXT NOT NULL DEFAULT '',
  research_note TEXT NOT NULL DEFAULT '',
  researched_at TIMESTAMPTZ,
  reject_reason TEXT NOT NULL DEFAULT '',
  sent_at       TIMESTAMPTZ,
  sent_subject  TEXT,
  message_id    TEXT,
  followup_at   TIMESTAMPTZ,
  followup_id   TEXT,
  reply_at      TIMESTAMPTZ,
  reply_snippet TEXT NOT NULL DEFAULT '',
  unsub_at      TIMESTAMPTZ,
  bounced_at    TIMESTAMPTZ,
  klacht_at     TIMESTAMPTZ,
  catalogus_at  TIMESTAMPTZ,
  error         TEXT NOT NULL DEFAULT '',
  klant_id      INTEGER,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX leads_email_uniq ON leads(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX leads_domain_uniq ON leads(domain) WHERE domain <> '';
CREATE INDEX leads_status_idx ON leads(status, updated_at DESC);
CREATE TABLE suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'afgemeld',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE mail_events (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  mail       TEXT NOT NULL DEFAULT 'eerste',   -- eerste | opvolging
  soort      TEXT NOT NULL,                    -- open | klik | catalogus
  url        TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX mail_events_lead_idx ON mail_events(lead_id, soort, created_at);

-- ------------------------------------------------------------------ website: catalogus en offertes
CREATE TABLE aanvragen (
  id         SERIAL PRIMARY KEY,
  -- catalogus | offerte
  soort      TEXT NOT NULL,
  naam       TEXT NOT NULL DEFAULT '',
  bedrijf    TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  telefoon   TEXT NOT NULL DEFAULT '',
  tafels     TEXT NOT NULL DEFAULT '',
  interesse  TEXT NOT NULL DEFAULT '',
  bericht    TEXT NOT NULL DEFAULT '',
  demo       BOOLEAN NOT NULL DEFAULT FALSE,
  -- herkomst: website | mail | meta | google | direct | anders
  bron       TEXT NOT NULL DEFAULT 'website',
  token      TEXT NOT NULL UNIQUE,
  downloads  INTEGER NOT NULL DEFAULT 0,
  gedownload_at TIMESTAMPTZ,
  -- nieuw | gebeld | offerte | klant | geen_interesse
  status     TEXT NOT NULL DEFAULT 'nieuw',
  notitie    TEXT NOT NULL DEFAULT '',
  lead_id    INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  klant_id   INTEGER,
  ip_hash    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX aanvragen_created_idx ON aanvragen(created_at DESC);

-- ------------------------------------------------------------------ klanten (horecazaken die bestellen)
CREATE TABLE klanten (
  id          SERIAL PRIMARY KEY,
  bedrijf     TEXT NOT NULL,
  contact     TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  telefoon    TEXT NOT NULL DEFAULT '',
  adres       TEXT NOT NULL DEFAULT '',
  postcode    TEXT NOT NULL DEFAULT '',
  plaats      TEXT NOT NULL DEFAULT '',
  land        TEXT NOT NULL DEFAULT 'Nederland',
  kvk         TEXT NOT NULL DEFAULT '',
  btw_nummer  TEXT NOT NULL DEFAULT '',
  notities    TEXT NOT NULL DEFAULT '',
  lead_id     INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------ producten
CREATE TABLE producten (
  id              SERIAL PRIMARY KEY,
  serie           TEXT NOT NULL,           -- '100' … '1200'
  code            TEXT NOT NULL UNIQUE,    -- modelnummer bij Lumiq, bijv. '101'
  naam            TEXT NOT NULL,           -- 'Goud'
  stijl           TEXT NOT NULL DEFAULT '',-- 'Trommel'
  maat            TEXT NOT NULL DEFAULT '',
  materiaal       TEXT NOT NULL DEFAULT '',
  leverancier_code TEXT NOT NULL DEFAULT '', -- modelnummer bij de leverancier, bijv. '14T8'
  afbeelding      TEXT NOT NULL DEFAULT '',
  inkoop_cents    INTEGER NOT NULL DEFAULT 0,  -- per stuk, excl. btw
  verkoop_cents   INTEGER NOT NULL DEFAULT 0,  -- per stuk, excl. btw
  moq             INTEGER NOT NULL DEFAULT 50,
  actief          BOOLEAN NOT NULL DEFAULT TRUE,
  notities        TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX producten_serie_idx ON producten(serie, code);

-- ------------------------------------------------------------------ verkooporders
CREATE SEQUENCE order_nummer_seq START 1;
CREATE TABLE orders (
  id            SERIAL PRIMARY KEY,
  nummer        TEXT NOT NULL UNIQUE,
  klant_id      INTEGER NOT NULL REFERENCES klanten(id) ON DELETE RESTRICT,
  -- besteld | in_productie | onderweg | binnen | geleverd | geannuleerd
  status        TEXT NOT NULL DEFAULT 'besteld',
  besteld_op    DATE NOT NULL DEFAULT CURRENT_DATE,
  leverdatum    DATE,               -- verwacht (uit de inkooporder) of afgesproken
  geleverd_op   DATE,
  referentie    TEXT NOT NULL DEFAULT '',
  notities      TEXT NOT NULL DEFAULT '',
  korting_cents INTEGER NOT NULL DEFAULT 0,
  verzend_cents INTEGER NOT NULL DEFAULT 0,
  aanvraag_id   INTEGER REFERENCES aanvragen(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT orders_status_check CHECK (status IN ('besteld','in_productie','onderweg','binnen','geleverd','geannuleerd'))
);
CREATE INDEX orders_status_idx ON orders(status, besteld_op DESC);
CREATE TABLE order_regels (
  id             SERIAL PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id     INTEGER REFERENCES producten(id) ON DELETE RESTRICT,
  omschrijving   TEXT NOT NULL DEFAULT '',   -- voor regels zonder product (laders, verzending, installatie)
  aantal         INTEGER NOT NULL CHECK (aantal > 0),
  prijs_cents    INTEGER NOT NULL DEFAULT 0, -- per stuk, excl. btw
  -- uit voorraad bij de leverancier (geen productie nodig, alleen verzenden)
  uit_voorraad   INTEGER NOT NULL DEFAULT 0,
  inkoop_id      INTEGER,                    -- de inkooporder waarmee deze regel komt
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_regels_order_idx ON order_regels(order_id);

-- ------------------------------------------------------------------ inkoop bij de leverancier
CREATE SEQUENCE inkoop_nummer_seq START 1;
CREATE TABLE inkooporders (
  id                SERIAL PRIMARY KEY,
  nummer            TEXT NOT NULL UNIQUE,
  leverancier       TEXT NOT NULL DEFAULT '',
  -- concept | besteld | in_productie | verzonden | ontvangen | geannuleerd
  status            TEXT NOT NULL DEFAULT 'concept',
  productie         BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE = alleen verzenden uit voorraad bij de leverancier
  besteld_op        DATE,
  productie_dagen   INTEGER NOT NULL DEFAULT 21,
  verzend_dagen     INTEGER NOT NULL DEFAULT 7,
  klaar_verwacht    DATE,
  binnen_verwacht   DATE,
  verzonden_op      DATE,
  ontvangen_op      DATE,
  vrachtkosten_cents INTEGER NOT NULL DEFAULT 0,
  tracking          TEXT NOT NULL DEFAULT '',
  notities          TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inkoop_status_check CHECK (status IN ('concept','besteld','in_productie','verzonden','ontvangen','geannuleerd'))
);
-- Per product: wat er geproduceerd wordt (≥ MOQ), wat uit de voorraad bij de leverancier komt, en wat naar Nederland gaat.
-- Rest na productie (productie + uit_voorraad − verzenden) blijft bij de leverancier liggen.
CREATE TABLE inkoop_regels (
  id            SERIAL PRIMARY KEY,
  inkoop_id     INTEGER NOT NULL REFERENCES inkooporders(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES producten(id) ON DELETE RESTRICT,
  productie     INTEGER NOT NULL DEFAULT 0 CHECK (productie >= 0),
  uit_voorraad  INTEGER NOT NULL DEFAULT 0 CHECK (uit_voorraad >= 0),
  voor_orders   INTEGER NOT NULL DEFAULT 0 CHECK (voor_orders >= 0),   -- deel dat al verkocht is
  verzenden     INTEGER NOT NULL DEFAULT 0 CHECK (verzenden >= 0),
  prijs_cents   INTEGER NOT NULL DEFAULT 0,                             -- inkoop per stuk (productie)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inkoop_regel_iets CHECK (productie + uit_voorraad > 0),
  CONSTRAINT inkoop_regel_verzenden CHECK (verzenden <= productie + uit_voorraad)
);
CREATE INDEX inkoop_regels_idx ON inkoop_regels(inkoop_id);

-- ------------------------------------------------------------------ voorraad (mutaties; de stand = de som)
CREATE TABLE voorraad_mutaties (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES producten(id) ON DELETE CASCADE,
  -- leverancier = ligt bij de fabriek in China | magazijn = ligt in Nederland
  locatie     TEXT NOT NULL,
  aantal      INTEGER NOT NULL,      -- + erbij, - eraf
  -- restant (MOQ-overschot) | verzonden (uit leveranciersvoorraad) | ontvangen | geleverd | correctie | beginvoorraad
  soort       TEXT NOT NULL,
  ref         TEXT NOT NULL DEFAULT '',
  notitie     TEXT NOT NULL DEFAULT '',
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT voorraad_locatie_check CHECK (locatie IN ('leverancier','magazijn'))
);
CREATE INDEX voorraad_product_idx ON voorraad_mutaties(product_id, locatie);

-- ------------------------------------------------------------------ finance
CREATE SEQUENCE factuur_nummer_seq START 1;
CREATE TABLE facturen (
  id            SERIAL PRIMARY KEY,
  nummer        TEXT NOT NULL UNIQUE,
  klant_id      INTEGER NOT NULL REFERENCES klanten(id) ON DELETE RESTRICT,
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  factuurdatum  DATE NOT NULL DEFAULT CURRENT_DATE,
  vervaldatum   DATE NOT NULL,
  omschrijving  TEXT NOT NULL DEFAULT '',
  regels        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{omschrijving, aantal, prijs_cents}]
  subtotaal_cents INTEGER NOT NULL,                   -- excl. btw
  btw_pct       NUMERIC(5,2) NOT NULL DEFAULT 21,
  btw_cents     INTEGER NOT NULL,
  totaal_cents  INTEGER NOT NULL,                     -- incl. btw
  -- concept | open | betaald | gecrediteerd
  status        TEXT NOT NULL DEFAULT 'open',
  verzonden_at  TIMESTAMPTZ,
  betaald_op    DATE,
  herinnering_at TIMESTAMPTZ,
  herinneringen INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factuur_status_check CHECK (status IN ('concept','open','betaald','gecrediteerd'))
);
CREATE INDEX facturen_status_idx ON facturen(status, vervaldatum);
