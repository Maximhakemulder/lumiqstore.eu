-- AI-team: vragen aan afdelingen, ochtendbriefing van de directeur en afgevinkte taken.
CREATE TABLE IF NOT EXISTS team_vragen (
  id          SERIAL PRIMARY KEY,
  afdeling    TEXT NOT NULL,
  vraag       TEXT NOT NULL,
  antwoord    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','klaar','fout')),
  door        TEXT NOT NULL DEFAULT '',
  pogingen    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  beantwoord_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_vragen_afdeling ON team_vragen (afdeling, created_at DESC);
CREATE INDEX IF NOT EXISTS team_vragen_open ON team_vragen (status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS team_briefings (
  dag         DATE PRIMARY KEY,
  inhoud      JSONB NOT NULL,
  bron        TEXT NOT NULL DEFAULT 'ai',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_taken (
  dag         DATE NOT NULL,
  taak_id     TEXT NOT NULL,
  door        TEXT NOT NULL DEFAULT '',
  gedaan_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dag, taak_id)
);
