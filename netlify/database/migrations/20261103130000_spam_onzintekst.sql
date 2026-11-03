-- Bestaande offerte-/catalogusaanvragen met willekeurige letters (bot) op status spam zetten (terug te zetten in HQ).
UPDATE aanvragen
   SET status = 'spam', notitie = 'Geblokkeerd: onzin-tekst', updated_at = NOW()
 WHERE status <> 'spam'
   AND COALESCE(klant_id, 0) = 0
   AND (naam || ' ' || bedrijf || ' ' || bericht) ~ '[A-Za-z]*([a-z][A-Z][A-Za-z]*){3,}'
   AND (naam || ' ' || bedrijf || ' ' || bericht) ~ '(^|[^A-Za-z])[a-z]*[A-Za-z]{10,}($|[^A-Za-z])';
