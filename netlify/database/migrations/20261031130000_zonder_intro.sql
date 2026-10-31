-- Eerste B2B-mail zonder AI-openingszin ({intro}); de tekst met de naam van de zaak is persoonlijk genoeg.
UPDATE settings
SET value = jsonb_set(value, '{templates,eerste,body}', to_jsonb(replace(value #>> '{templates,eerste,body}', '{intro}', ''))), updated_at = NOW()
WHERE key = 'b2b' AND value #>> '{templates,eerste,body}' LIKE '%{intro}%';
