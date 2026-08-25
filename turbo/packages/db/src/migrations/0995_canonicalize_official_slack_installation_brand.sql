-- Final canonicalization after the official-brand writer gate has shipped.
UPDATE "slack_org_installations"
SET "public_brand" = 'okou'
WHERE "public_brand" <> 'okou';
