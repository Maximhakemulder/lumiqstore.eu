-- Eerste B2B-mail: zin over het systeem (alle lampen tegelijk bedienen) voor de brochure.
UPDATE settings
SET value = jsonb_set(value, '{templates,eerste,body}', to_jsonb(replace(value #>> '{templates,eerste,body}',
      E'op tafel staan.\n\nHieronder vindt u',
      E'op tafel staan.\n\nMet ons systeem bedient u al uw lampen tegelijk: met één tik via de app of het touchpaneel gaat de hele zaak aan. Draadloos, tot 24 uur licht per lading en ook geschikt voor het terras.\n\nHieronder vindt u'))),
    updated_at = NOW()
WHERE key = 'b2b' AND value #>> '{templates,eerste,body}' NOT LIKE '%Met ons systeem bedient%';
