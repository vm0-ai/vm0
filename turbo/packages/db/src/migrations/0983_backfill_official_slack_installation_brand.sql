-- Custom SQL migration file for the official Slack installation brand backfill.
UPDATE "slack_org_installations"
SET "public_brand" = 'okou'
WHERE "public_brand" <> 'okou';
