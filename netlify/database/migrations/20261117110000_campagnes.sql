-- Losse mailcampagnes naar bestaande leads (bijv. "Klant uitgelicht: Van der Valk").
-- Eigen teller en daglimiet, los van de gewone B2B-mails.
CREATE TABLE campagnes (
  id          SERIAL PRIMARY KEY,
  sleutel     TEXT NOT NULL,
  naam        TEXT NOT NULL,
  onderwerp   TEXT NOT NULL,
  html        TEXT NOT NULL,
  tekst       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'actief',
  per_dag     INTEGER NOT NULL DEFAULT 120,
  gestart_door TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  klaar_at    TIMESTAMPTZ
);
CREATE TABLE campagne_ontvangers (
  id           SERIAL PRIMARY KEY,
  campagne_id  INTEGER NOT NULL REFERENCES campagnes(id) ON DELETE CASCADE,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'wachtend',
  error        TEXT NOT NULL DEFAULT '',
  sent_at      TIMESTAMPTZ,
  UNIQUE (campagne_id, lead_id)
);
CREATE INDEX campagne_ontvangers_idx ON campagne_ontvangers(campagne_id, status);
