-- Aanhef van de B2B-mails: "Hi," in plaats van "Hallo,". Overige aanpassingen in de teksten blijven staan.
UPDATE settings
SET value = jsonb_set(jsonb_set(value,
      '{templates,eerste,body}', to_jsonb(regexp_replace(value #>> '{templates,eerste,body}', '^Hallo,', 'Hi,'))),
      '{templates,opvolging,body}', to_jsonb(regexp_replace(value #>> '{templates,opvolging,body}', '^Hallo,', 'Hi,'))),
    updated_at = NOW()
WHERE key = 'b2b' AND value #>> '{templates,eerste,body}' IS NOT NULL AND value #>> '{templates,opvolging,body}' IS NOT NULL;
