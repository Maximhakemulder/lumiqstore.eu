-- Keuze Maxim 19-11-2026: scout opschalen voor 500 B2B-mails per dag.
-- Scout aan, ~700 zaken per dag, en meer plaatsen (bestaande plaatsen blijven, nieuwe komen erachter).
UPDATE settings SET value = jsonb_set(value, '{scout}', COALESCE(value->'scout', '{}'::jsonb), true) WHERE key = 'b2b';
UPDATE settings
SET value = jsonb_set(jsonb_set(jsonb_set(value,
      '{scout,active}', 'true'::jsonb, true),
      '{scout,perDay}', '700'::jsonb, true),
      '{scout,places}', (
        SELECT to_jsonb(array_agg(p ORDER BY o)) FROM (
          SELECT p, MIN(o) AS o FROM (
            SELECT e.p, e.o FROM jsonb_array_elements_text(COALESCE(value#>'{scout,places}', '[]'::jsonb)) WITH ORDINALITY AS e(p, o)
            UNION ALL
            SELECT n.p, 1000 + n.o FROM unnest(ARRAY['Rotterdam','Amsterdam','Den Haag','Utrecht','Breda','Eindhoven','Haarlem','Leiden','Delft','Groningen','Maastricht','Arnhem','Nijmegen','''s-Hertogenbosch','Tilburg','Zwolle','Amersfoort','Apeldoorn','Enschede','Alkmaar','Dordrecht','Zoetermeer','Hilversum','Gouda','Deventer','Leeuwarden','Almere','Middelburg','Roermond','Venlo','Bergen op Zoom','Noordwijk','Zandvoort','Scheveningen','Valkenburg','Wassenaar','Bloemendaal','Naarden','Laren','Oisterwijk']::text[]) WITH ORDINALITY AS n(p, o)
          ) alle GROUP BY p
        ) u
      ), true),
    updated_at = NOW()
WHERE key = 'b2b';
