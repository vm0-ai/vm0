-- Migration facts generated from the connector registry on 2026-05-28:
-- 211 api-token manual connectors, 262 field names, no duplicate field names.
-- Optional fields currently exist only for agora and gitlab.
WITH api_token_fields(connector_type, field_name, storage, required) AS (
  VALUES
    ('adzuna', 'ADZUNA_APP_ID', 'variable', true),
    ('adzuna', 'ADZUNA_APP_KEY', 'secret', true),
    ('agentmail', 'AGENTMAIL_TOKEN', 'secret', true),
    ('agora', 'AGORA_APP_CERTIFICATE', 'secret', false),
    ('agora', 'AGORA_APP_ID', 'variable', true),
    ('agora', 'AGORA_CUSTOMER_ID', 'secret', true),
    ('agora', 'AGORA_CUSTOMER_SECRET', 'secret', true),
    ('ahrefs', 'AHREFS_TOKEN', 'secret', true),
    ('alchemy', 'ALCHEMY_API_KEY', 'secret', true),
    ('altium-365', 'ALTIUM365_TOKEN', 'secret', true),
    ('altium-365', 'ALTIUM365_WORKSPACE_URL', 'variable', true),
    ('amadeus', 'AMADEUS_API_KEY', 'secret', true),
    ('amadeus', 'AMADEUS_API_SECRET', 'secret', true),
    ('amplitude', 'AMPLITUDE_API_KEY', 'secret', true),
    ('amplitude', 'AMPLITUDE_SECRET_KEY', 'secret', true),
    ('anthropic-managed-agents', 'ANTHROPIC_MANAGED_AGENTS_TOKEN', 'secret', true),
    ('apify', 'APIFY_TOKEN', 'secret', true),
    ('apollo', 'APOLLO_TOKEN', 'secret', true),
    ('atlascloud', 'ATLASCLOUD_API_KEY', 'secret', true),
    ('atlassian', 'ATLASSIAN_DOMAIN', 'variable', true),
    ('atlassian', 'ATLASSIAN_EMAIL', 'variable', true),
    ('atlassian', 'ATLASSIAN_TOKEN', 'secret', true),
    ('attio', 'ATTIO_TOKEN', 'secret', true),
    ('aviationstack', 'AVIATIONSTACK_TOKEN', 'secret', true),
    ('axiom', 'AXIOM_TOKEN', 'secret', true),
    ('bentoml', 'BENTO_CLOUD_API_ENDPOINT', 'variable', true),
    ('bentoml', 'BENTO_CLOUD_API_KEY', 'secret', true),
    ('bfl', 'BFL_API_KEY', 'secret', true),
    ('bitrefill', 'BITREFILL_TOKEN', 'secret', true),
    ('bitrix', 'BITRIX_WEBHOOK_URL', 'secret', true),
    ('bland', 'BLAND_API_KEY', 'secret', true),
    ('brave-search', 'BRAVE_API_KEY', 'secret', true),
    ('brevo', 'BREVO_TOKEN', 'secret', true),
    ('brex', 'BREX_TOKEN', 'secret', true),
    ('bright-data', 'BRIGHTDATA_TOKEN', 'secret', true),
    ('browser-use', 'BROWSER_USE_TOKEN', 'secret', true),
    ('browserbase', 'BROWSERBASE_PROJECT_ID', 'variable', true),
    ('browserbase', 'BROWSERBASE_TOKEN', 'secret', true),
    ('browserless', 'BROWSERLESS_TOKEN', 'secret', true),
    ('browserstack', 'BROWSERSTACK_ACCESS_KEY', 'secret', true),
    ('browserstack', 'BROWSERSTACK_USERNAME', 'secret', true),
    ('bubblemaps', 'BUBBLEMAPS_API_KEY', 'secret', true),
    ('buffer', 'BUFFER_TOKEN', 'secret', true),
    ('builtwith', 'BUILTWITH_TOKEN', 'secret', true),
    ('cal-com', 'CALCOM_TOKEN', 'secret', true),
    ('calendly', 'CALENDLY_TOKEN', 'secret', true),
    ('chatwoot', 'CHATWOOT_TOKEN', 'secret', true),
    ('checkr', 'CHECKR_TOKEN', 'secret', true),
    ('clado', 'CLADO_TOKEN', 'secret', true),
    ('clearbit', 'CLEARBIT_TOKEN', 'secret', true),
    ('clerk', 'CLERK_TOKEN', 'secret', true),
    ('clickup', 'CLICKUP_TOKEN', 'secret', true),
    ('cloudflare', 'CLOUDFLARE_TOKEN', 'secret', true),
    ('cloudinary', 'CLOUDINARY_API_SECRET', 'secret', true),
    ('cloudinary', 'CLOUDINARY_CLOUD_NAME', 'variable', true),
    ('cloudinary', 'CLOUDINARY_TOKEN', 'secret', true),
    ('coda', 'CODA_TOKEN', 'secret', true),
    ('coingecko', 'COINGECKO_TOKEN', 'secret', true),
    ('coresignal', 'CORESIGNAL_TOKEN', 'secret', true),
    ('cronlytic', 'CRONLYTIC_API_KEY', 'secret', true),
    ('cronlytic', 'CRONLYTIC_USER_ID', 'variable', true),
    ('crustdata', 'CRUSTDATA_TOKEN', 'secret', true),
    ('customer-io', 'CUSTOMERIO_APP_TOKEN', 'secret', true),
    ('db9', 'DB9_API_KEY', 'secret', true),
    ('deel', 'DEEL_TOKEN', 'secret', true),
    ('deepseek', 'DEEPSEEK_TOKEN', 'secret', true),
    ('defillama', 'DEFILLAMA_TOKEN', 'secret', true),
    ('devto', 'DEVTO_TOKEN', 'secret', true),
    ('diffbot', 'DIFFBOT_TOKEN', 'secret', true),
    ('dify', 'DIFY_TOKEN', 'secret', true),
    ('discord', 'DISCORD_BOT_TOKEN', 'secret', true),
    ('discord-webhook', 'DISCORD_WEBHOOK_URL', 'secret', true),
    ('doppler', 'DOPPLER_TOKEN', 'secret', true),
    ('doubao', 'DOUBAO_API_KEY', 'secret', true),
    ('drive9', 'DRIVE9_TOKEN', 'secret', true),
    ('dropbox', 'DROPBOX_TOKEN', 'secret', true),
    ('dropbox-sign', 'DROPBOX_SIGN_TOKEN', 'secret', true),
    ('duffel', 'DUFFEL_TOKEN', 'secret', true),
    ('e2b', 'E2B_TOKEN', 'secret', true),
    ('elevenlabs', 'ELEVENLABS_TOKEN', 'secret', true),
    ('etherscan', 'ETHERSCAN_API_KEY', 'secret', true),
    ('etsy', 'ETSY_TOKEN', 'secret', true),
    ('exa', 'EXA_TOKEN', 'secret', true),
    ('explorium', 'EXPLORIUM_TOKEN', 'secret', true),
    ('faire', 'FAIRE_TOKEN', 'secret', true),
    ('fal', 'FAL_TOKEN', 'secret', true),
    ('figma', 'FIGMA_TOKEN', 'secret', true),
    ('firecrawl', 'FIRECRAWL_TOKEN', 'secret', true),
    ('fireflies', 'FIREFLIES_TOKEN', 'secret', true),
    ('flightaware', 'FLIGHTAWARE_TOKEN', 'secret', true),
    ('freshdesk', 'FRESHDESK_DOMAIN', 'variable', true),
    ('freshdesk', 'FRESHDESK_TOKEN', 'secret', true),
    ('gamma', 'GAMMA_TOKEN', 'secret', true),
    ('gemini', 'GEMINI_TOKEN', 'secret', true),
    ('gitlab', 'GITLAB_HOST', 'variable', false),
    ('gitlab', 'GITLAB_TOKEN', 'secret', true),
    ('gong', 'GONG_ACCESS_KEY', 'secret', true),
    ('gong', 'GONG_ACCESS_KEY_SECRET', 'secret', true),
    ('gong', 'GONG_API_BASE', 'variable', true),
    ('google-maps', 'GOOGLE_MAPS_TOKEN', 'secret', true),
    ('granola', 'GRANOLA_TOKEN', 'secret', true),
    ('greenhouse', 'GREENHOUSE_TOKEN', 'secret', true),
    ('groq', 'GROQ_TOKEN', 'secret', true),
    ('gumroad', 'GUMROAD_TOKEN', 'secret', true),
    ('helicone', 'HELICONE_TOKEN', 'secret', true),
    ('heygen', 'HEYGEN_TOKEN', 'secret', true),
    ('honcho', 'HONCHO_API_KEY', 'secret', true),
    ('htmlcsstoimage', 'HCTI_API_KEY', 'secret', true),
    ('htmlcsstoimage', 'HCTI_USER_ID', 'variable', true),
    ('hugging-face', 'HUGGING_FACE_TOKEN', 'secret', true),
    ('hume', 'HUME_TOKEN', 'secret', true),
    ('hunter', 'HUNTER_TOKEN', 'secret', true),
    ('imgur', 'IMGUR_CLIENT_ID', 'secret', true),
    ('infisical', 'INFISICAL_TOKEN', 'secret', true),
    ('instagram', 'INSTAGRAM_BUSINESS_ACCOUNT_ID', 'variable', true),
    ('instagram', 'INSTAGRAM_TOKEN', 'secret', true),
    ('instantly', 'INSTANTLY_API_KEY', 'secret', true),
    ('intercom', 'INTERCOM_TOKEN', 'secret', true),
    ('ironclad', 'IRONCLAD_API_KEY', 'secret', true),
    ('ironclad', 'IRONCLAD_HOST', 'variable', true),
    ('jam', 'JAM_TOKEN', 'secret', true),
    ('jira', 'JIRA_API_TOKEN', 'secret', true),
    ('jira', 'JIRA_DOMAIN', 'variable', true),
    ('jira', 'JIRA_EMAIL', 'variable', true),
    ('jotform', 'JOTFORM_TOKEN', 'secret', true),
    ('klaviyo', 'KLAVIYO_TOKEN', 'secret', true),
    ('kommo', 'KOMMO_API_KEY', 'secret', true),
    ('kommo', 'KOMMO_SUBDOMAIN', 'variable', true),
    ('langfuse', 'LANGFUSE_PUBLIC_KEY', 'secret', true),
    ('langfuse', 'LANGFUSE_SECRET_KEY', 'secret', true),
    ('langsmith', 'LANGSMITH_TOKEN', 'secret', true),
    ('lark', 'LARK_APP_ID', 'variable', true),
    ('lark', 'LARK_TOKEN', 'secret', true),
    ('line', 'LINE_TOKEN', 'secret', true),
    ('loops', 'LOOPS_TOKEN', 'secret', true),
    ('luma', 'LUMA_API_KEY', 'secret', true),
    ('luma-ai', 'LUMA_TOKEN', 'secret', true),
    ('mailchimp', 'MAILCHIMP_TOKEN', 'secret', true),
    ('mailsac', 'MAILSAC_TOKEN', 'secret', true),
    ('make', 'MAKE_TOKEN', 'secret', true),
    ('manus', 'MANUS_TOKEN', 'secret', true),
    ('mapbox', 'MAPBOX_TOKEN', 'secret', true),
    ('mathpix', 'MATHPIX_APP_ID', 'variable', true),
    ('mathpix', 'MATHPIX_APP_KEY', 'secret', true),
    ('mem0', 'MEM0_TOKEN', 'secret', true),
    ('mercury', 'MERCURY_TOKEN', 'secret', true),
    ('meshy', 'MESHY_API_KEY', 'secret', true),
    ('metabase', 'METABASE_BASE_URL', 'variable', true),
    ('metabase', 'METABASE_TOKEN', 'secret', true),
    ('minimax', 'MINIMAX_TOKEN', 'secret', true),
    ('minio', 'MINIO_ENDPOINT', 'variable', true),
    ('minio', 'MINIO_SECRET_TOKEN', 'secret', true),
    ('minio', 'MINIO_TOKEN', 'secret', true),
    ('miro', 'MIRO_TOKEN', 'secret', true),
    ('mixpanel', 'MIXPANEL_PROJECT_ID', 'variable', true),
    ('mixpanel', 'MIXPANEL_SERVICE_ACCOUNT_SECRET', 'secret', true),
    ('mixpanel', 'MIXPANEL_SERVICE_ACCOUNT_USERNAME', 'secret', true),
    ('moss', 'MOSS_PROJECT_ID', 'secret', true),
    ('moss', 'MOSS_PROJECT_KEY', 'secret', true),
    ('msg9', 'MSG9_TOKEN', 'secret', true),
    ('n8n', 'N8N_BASE_URL', 'variable', true),
    ('n8n', 'N8N_TOKEN', 'secret', true),
    ('neon', 'NEON_TOKEN', 'secret', true),
    ('novita', 'NOVITA_TOKEN', 'secret', true),
    ('nyne', 'NYNE_API_KEY', 'secret', true),
    ('nyne', 'NYNE_API_SECRET', 'secret', true),
    ('onyx', 'ONYX_TOKEN', 'secret', true),
    ('openai', 'OPENAI_TOKEN', 'secret', true),
    ('openrouter', 'OPENROUTER_TOKEN', 'secret', true),
    ('openweather', 'OPENWEATHER_TOKEN', 'secret', true),
    ('pandadoc', 'PANDADOC_TOKEN', 'secret', true),
    ('parallel', 'PARALLEL_API_KEY', 'secret', true),
    ('pdf4me', 'PDF4ME_TOKEN', 'secret', true),
    ('pdfco', 'PDFCO_TOKEN', 'secret', true),
    ('pdforge', 'PDFORGE_API_KEY', 'secret', true),
    ('people-data-labs', 'PEOPLE_DATA_LABS_API_KEY', 'secret', true),
    ('perplexity', 'PERPLEXITY_TOKEN', 'secret', true),
    ('pika', 'PIKA_TOKEN', 'secret', true),
    ('pinecone', 'PINECONE_TOKEN', 'secret', true),
    ('pipedream', 'PIPEDREAM_TOKEN', 'secret', true),
    ('pipedrive', 'PIPEDRIVE_TOKEN', 'secret', true),
    ('plain', 'PLAIN_TOKEN', 'secret', true),
    ('plausible', 'PLAUSIBLE_TOKEN', 'secret', true),
    ('podchaser', 'PODCHASER_TOKEN', 'secret', true),
    ('porkbun', 'PORKBUN_API_KEY', 'secret', true),
    ('porkbun', 'PORKBUN_SECRET_API_KEY', 'secret', true),
    ('posthog', 'POSTHOG_TOKEN', 'secret', true),
    ('printful', 'PRINTFUL_TOKEN', 'secret', true),
    ('prisma-postgres', 'PRISMA_POSTGRES_TOKEN', 'secret', true),
    ('productlane', 'PRODUCTLANE_TOKEN', 'secret', true),
    ('pushinator', 'PUSHINATOR_TOKEN', 'secret', true),
    ('qdrant', 'QDRANT_BASE_URL', 'variable', true),
    ('qdrant', 'QDRANT_TOKEN', 'secret', true),
    ('qiita', 'QIITA_TOKEN', 'secret', true),
    ('railway', 'RAILWAY_TOKEN', 'secret', true),
    ('railway-project', 'RAILWAY_PROJECT_TOKEN', 'secret', true),
    ('reap', 'REAP_API_BASE_URL', 'variable', true),
    ('reap', 'REAP_API_KEY', 'secret', true),
    ('recraft', 'RECRAFT_API_TOKEN', 'secret', true),
    ('reducto', 'REDUCTO_TOKEN', 'secret', true),
    ('rentcast', 'RENTCAST_API_KEY', 'secret', true),
    ('replicate', 'REPLICATE_TOKEN', 'secret', true),
    ('reportei', 'REPORTEI_TOKEN', 'secret', true),
    ('resend', 'RESEND_TOKEN', 'secret', true),
    ('revenuecat', 'REVENUECAT_TOKEN', 'secret', true),
    ('runway', 'RUNWAY_TOKEN', 'secret', true),
    ('salesforce', 'SALESFORCE_INSTANCE', 'variable', true),
    ('salesforce', 'SALESFORCE_TOKEN', 'secret', true),
    ('scrapeninja', 'SCRAPENINJA_TOKEN', 'secret', true),
    ('segment', 'SEGMENT_TOKEN', 'secret', true),
    ('sendgrid', 'SENDGRID_TOKEN', 'secret', true),
    ('serpapi', 'SERPAPI_TOKEN', 'secret', true),
    ('servicenow', 'SERVICENOW_INSTANCE', 'variable', true),
    ('servicenow', 'SERVICENOW_PASSWORD', 'secret', true),
    ('servicenow', 'SERVICENOW_USERNAME', 'secret', true),
    ('shopify', 'SHOPIFY_SHOP', 'variable', true),
    ('shopify', 'SHOPIFY_TOKEN', 'secret', true),
    ('shortio', 'SHORTIO_TOKEN', 'secret', true),
    ('similarweb', 'SIMILARWEB_TOKEN', 'secret', true),
    ('slack-webhook', 'SLACK_WEBHOOK_URL', 'secret', true),
    ('snowflake', 'SNOWFLAKE_ACCOUNT', 'variable', true),
    ('snowflake', 'SNOWFLAKE_PAT', 'secret', true),
    ('sociavault', 'SOCIAVAULT_TOKEN', 'secret', true),
    ('sponge', 'SPONGE_MASTER_KEY', 'secret', true),
    ('sproutgigs', 'SPROUTGIGS_API_SECRET', 'secret', true),
    ('sproutgigs', 'SPROUTGIGS_USER_ID', 'variable', true),
    ('square', 'SQUARE_TOKEN', 'secret', true),
    ('stability-ai', 'STABILITY_TOKEN', 'secret', true),
    ('strapi', 'STRAPI_BASE_URL', 'variable', true),
    ('strapi', 'STRAPI_TOKEN', 'secret', true),
    ('streak', 'STREAK_TOKEN', 'secret', true),
    ('stripe', 'STRIPE_TOKEN', 'secret', true),
    ('supabase', 'SUPABASE_TOKEN', 'secret', true),
    ('supadata', 'SUPADATA_TOKEN', 'secret', true),
    ('supermemory', 'SUPERMEMORY_API_KEY', 'secret', true),
    ('tavily', 'TAVILY_TOKEN', 'secret', true),
    ('testrail', 'TESTRAIL_EMAIL', 'secret', true),
    ('testrail', 'TESTRAIL_INSTANCE', 'variable', true),
    ('testrail', 'TESTRAIL_TOKEN', 'secret', true),
    ('ticketmaster', 'TICKETMASTER_API_KEY', 'secret', true),
    ('tldv', 'TLDV_TOKEN', 'secret', true),
    ('together', 'TOGETHER_TOKEN', 'secret', true),
    ('twenty', 'TWENTY_TOKEN', 'secret', true),
    ('twilio', 'TWILIO_ACCOUNT_SID', 'secret', true),
    ('twilio', 'TWILIO_AUTH_TOKEN', 'secret', true),
    ('typeform', 'TYPEFORM_TOKEN', 'secret', true),
    ('v0', 'V0_TOKEN', 'secret', true),
    ('wandb', 'WANDB_TOKEN', 'secret', true),
    ('webflow', 'WEBFLOW_TOKEN', 'secret', true),
    ('weread', 'WEREAD_TOKEN', 'secret', true),
    ('whale-alert', 'WHALE_ALERT_API_KEY', 'secret', true),
    ('wix', 'WIX_TOKEN', 'secret', true),
    ('workos', 'WORKOS_TOKEN', 'secret', true),
    ('wrike', 'WRIKE_TOKEN', 'secret', true),
    ('youtube', 'YOUTUBE_TOKEN', 'secret', true),
    ('zapier', 'ZAPIER_TOKEN', 'secret', true),
    ('zapsign', 'ZAPSIGN_TOKEN', 'secret', true),
    ('zendesk', 'ZENDESK_API_TOKEN', 'secret', true),
    ('zendesk', 'ZENDESK_EMAIL', 'variable', true),
    ('zendesk', 'ZENDESK_SUBDOMAIN', 'variable', true),
    ('zep', 'ZEP_TOKEN', 'secret', true),
    ('zeptomail', 'ZEPTOMAIL_TOKEN', 'secret', true)
),
required_field_counts AS (
  SELECT
    connector_type,
    COUNT(*) FILTER (WHERE required) AS required_count
  FROM api_token_fields
  GROUP BY connector_type
),
legacy_field_presence AS (
  SELECT
    fields.connector_type,
    user_secrets.org_id,
    user_secrets.user_id,
    fields.field_name,
    fields.storage,
    fields.required
  FROM api_token_fields fields
  JOIN secrets user_secrets
    ON fields.storage = 'secret'
   AND user_secrets.type = 'user'
   AND user_secrets.name = fields.field_name
   AND user_secrets.user_id <> '__org__'

  UNION ALL

  SELECT
    fields.connector_type,
    user_variables.org_id,
    user_variables.user_id,
    fields.field_name,
    fields.storage,
    fields.required
  FROM api_token_fields fields
  JOIN variables user_variables
    ON fields.storage = 'variable'
   AND user_variables.type = 'user'
   AND user_variables.name = fields.field_name
   AND user_variables.user_id <> '__org__'
),
eligible_legacy_connectors AS (
  SELECT
    presence.connector_type,
    presence.org_id,
    presence.user_id
  FROM legacy_field_presence presence
  JOIN required_field_counts counts
    ON counts.connector_type = presence.connector_type
  WHERE NOT EXISTS (
    SELECT 1
    FROM connectors existing_connector
    WHERE existing_connector.org_id = presence.org_id
      AND existing_connector.user_id = presence.user_id
      AND existing_connector.type = presence.connector_type
  )
  GROUP BY
    presence.connector_type,
    presence.org_id,
    presence.user_id,
    counts.required_count
  HAVING COUNT(DISTINCT presence.field_name) FILTER (WHERE presence.required) = counts.required_count
     AND counts.required_count > 0
),
migrated_connectors AS (
  INSERT INTO connectors (
    org_id,
    user_id,
    type,
    auth_method,
    needs_reconnect,
    created_at,
    updated_at
  )
  SELECT
    eligible.org_id,
    eligible.user_id,
    eligible.connector_type,
    'api-token',
    false,
    NOW(),
    NOW()
  FROM eligible_legacy_connectors eligible
  ON CONFLICT (org_id, user_id, type) DO NOTHING
  RETURNING org_id, user_id, type
),
copied_secrets AS (
  INSERT INTO secrets (
    org_id,
    user_id,
    name,
    encrypted_value,
    description,
    type,
    created_at,
    updated_at
  )
  SELECT
    source.org_id,
    source.user_id,
    source.name,
    source.encrypted_value,
    source.description,
    'connector',
    source.created_at,
    source.updated_at
  FROM migrated_connectors migrated
  JOIN api_token_fields fields
    ON fields.connector_type = migrated.type
   AND fields.storage = 'secret'
  JOIN secrets source
    ON source.org_id = migrated.org_id
   AND source.user_id = migrated.user_id
   AND source.type = 'user'
   AND source.name = fields.field_name
  ON CONFLICT (org_id, user_id, name, type) DO UPDATE SET
    encrypted_value = EXCLUDED.encrypted_value,
    description = EXCLUDED.description,
    updated_at = EXCLUDED.updated_at
  RETURNING org_id, user_id, name
),
copied_variables AS (
  INSERT INTO variables (
    org_id,
    user_id,
    name,
    value,
    description,
    type,
    created_at,
    updated_at
  )
  SELECT
    source.org_id,
    source.user_id,
    source.name,
    source.value,
    source.description,
    'connector',
    source.created_at,
    source.updated_at
  FROM migrated_connectors migrated
  JOIN api_token_fields fields
    ON fields.connector_type = migrated.type
   AND fields.storage = 'variable'
  JOIN variables source
    ON source.org_id = migrated.org_id
   AND source.user_id = migrated.user_id
   AND source.type = 'user'
   AND source.name = fields.field_name
  ON CONFLICT (org_id, user_id, type, name) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = EXCLUDED.updated_at
  RETURNING org_id, user_id, name
),
deleted_legacy_secrets AS (
  DELETE FROM secrets legacy
  USING copied_secrets copied
  WHERE legacy.org_id = copied.org_id
    AND legacy.user_id = copied.user_id
    AND legacy.name = copied.name
    AND legacy.type = 'user'
  RETURNING legacy.id
),
deleted_legacy_variables AS (
  DELETE FROM variables legacy
  USING copied_variables copied
  WHERE legacy.org_id = copied.org_id
    AND legacy.user_id = copied.user_id
    AND legacy.name = copied.name
    AND legacy.type = 'user'
  RETURNING legacy.id
)
SELECT 1;
