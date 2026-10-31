-- Eén mailadres voor alles: armand@lumiqstore.com (op facturen, onder mails, op de website).
UPDATE settings SET value = jsonb_set(value, '{email}', '"armand@lumiqstore.com"'), updated_at = NOW()
WHERE key = 'company' AND value ->> 'email' = 'info@lumiqstore.eu';
