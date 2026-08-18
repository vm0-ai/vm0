UPDATE "feishu_org_installations" AS "installation"
SET "custom_connector_id" = "connector"."id"
FROM "org_custom_connectors" AS "connector"
INNER JOIN "org_custom_connector_oauth_configs" AS "oauth_config"
  ON "oauth_config"."connector_id" = "connector"."id"
  AND "oauth_config"."org_id" = "connector"."org_id"
WHERE "installation"."custom_connector_id" IS NULL
  AND "connector"."org_id" = "installation"."org_id"
  AND "connector"."slug" = '_feishu-' || "installation"."id"::text
  AND "oauth_config"."provider_adapter" = 'feishu'
  AND "oauth_config"."client_id" = "installation"."app_id";

DELETE FROM "org_custom_connectors" AS "connector"
USING "org_custom_connector_oauth_configs" AS "oauth_config"
WHERE "oauth_config"."connector_id" = "connector"."id"
  AND "oauth_config"."org_id" = "connector"."org_id"
  AND "oauth_config"."provider_adapter" = 'feishu'
  AND "connector"."slug" ~ '^_feishu-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND "connector"."auth_mode" = 'oauth'
  AND "connector"."prefix_templates" = '["https://open.feishu.cn/open-apis/"]'::jsonb
  AND NOT EXISTS (
    SELECT 1
    FROM "feishu_org_installations" AS "installation"
    WHERE "installation"."custom_connector_id" = "connector"."id"
      AND "installation"."org_id" = "connector"."org_id"
  );
