-- Keuze Maxim 19-11-2026: 500 B2B-mails per verzenddag, gelijk verdeeld over de verzenduren.
-- Zet de opgeslagen daglimiet op 500 en "max. per uur" op automatisch (0 = daglimiet / verzenduren).
UPDATE settings
SET value = jsonb_set(jsonb_set(value, '{dailyMax}', '500'::jsonb, true), '{perUur}', '0'::jsonb, true), updated_at = NOW()
WHERE key = 'b2b';
