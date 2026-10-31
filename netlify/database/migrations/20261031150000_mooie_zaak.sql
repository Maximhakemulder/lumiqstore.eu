-- Eerste mail: "foto's van jullie mooie zaak"; opvolgmail: zin dat de lampen mooi zouden staan bij de zaak.
UPDATE settings
SET value = jsonb_set(jsonb_set(value,
      '{templates,eerste,body}', to_jsonb(replace(value #>> '{templates,eerste,body}', 'en zag de sfeervolle foto''s van jullie zaak.', 'en zag de foto''s van jullie mooie zaak.'))),
      '{templates,opvolging,body}', to_jsonb(replace(value #>> '{templates,opvolging,body}', 'met draadloze tafellampen. Heeft u er al even naar kunnen kijken?', 'met draadloze tafellampen. Ik denk echt dat onze lampen mooi zouden staan bij {bedrijf}. Heeft u er al even naar kunnen kijken?'))),
    updated_at = NOW()
WHERE key = 'b2b' AND value #>> '{templates,eerste,body}' IS NOT NULL AND value #>> '{templates,opvolging,body}' IS NOT NULL;
