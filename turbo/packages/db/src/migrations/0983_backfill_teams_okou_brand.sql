-- Custom SQL migration file, put your code below! --
UPDATE "teams_org_installations"
SET "public_brand" = 'okou'
WHERE "public_brand" <> 'okou';
