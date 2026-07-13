-- Snapshot of the current connector identities, grant kinds, and the
-- connector-scoped secret and variable names owned by each identity.
DROP TABLE IF EXISTS pg_temp.vm0_supported_connector_identities;
--> statement-breakpoint
CREATE TEMP TABLE vm0_supported_connector_identities (
  type text NOT NULL,
  auth_method text NOT NULL,
  grant_kind text NOT NULL,
  secret_names text[] NOT NULL,
  variable_names text[] NOT NULL,
  PRIMARY KEY (type, auth_method)
) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO vm0_supported_connector_identities (
  type,
  auth_method,
  grant_kind,
  secret_names,
  variable_names
)
VALUES
    ('github', 'oauth', 'auth-code', ARRAY['GITHUB_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('gmail', 'oauth', 'auth-code', ARRAY['GMAIL_ACCESS_TOKEN', 'GMAIL_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('notion', 'oauth', 'auth-code', ARRAY['NOTION_ACCESS_TOKEN', 'NOTION_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('x', 'oauth', 'auth-code', ARRAY['X_ACCESS_TOKEN', 'X_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-drive', 'oauth', 'auth-code', ARRAY['GOOGLE_DRIVE_ACCESS_TOKEN', 'GOOGLE_DRIVE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('slack', 'oauth', 'auth-code', ARRAY['SLACK_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('slock', 'oauth', 'device-auth', ARRAY['SLOCK_ACCESS_TOKEN', 'SLOCK_REFRESH_TOKEN', 'SLOCK_SERVER_ID'], ARRAY[]::text[]),
    ('google-sheets', 'oauth', 'auth-code', ARRAY['GOOGLE_SHEETS_ACCESS_TOKEN', 'GOOGLE_SHEETS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-calendar', 'oauth', 'auth-code', ARRAY['GOOGLE_CALENDAR_ACCESS_TOKEN', 'GOOGLE_CALENDAR_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-docs', 'oauth', 'auth-code', ARRAY['GOOGLE_DOCS_ACCESS_TOKEN', 'GOOGLE_DOCS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('linear', 'oauth', 'auth-code', ARRAY['LINEAR_ACCESS_TOKEN', 'LINEAR_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('intervals-icu', 'oauth', 'auth-code', ARRAY['INTERVALS_ICU_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('vercel', 'oauth', 'auth-code', ARRAY['VERCEL_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('strava', 'oauth', 'auth-code', ARRAY['STRAVA_ACCESS_TOKEN', 'STRAVA_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-meet', 'oauth', 'auth-code', ARRAY['GOOGLE_MEET_ACCESS_TOKEN', 'GOOGLE_MEET_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-search-console', 'oauth', 'auth-code', ARRAY['GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN', 'GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-analytics', 'oauth', 'auth-code', ARRAY['GOOGLE_ANALYTICS_ACCESS_TOKEN', 'GOOGLE_ANALYTICS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('hubspot', 'oauth', 'auth-code', ARRAY['HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('sentry', 'oauth', 'auth-code', ARRAY['SENTRY_ACCESS_TOKEN', 'SENTRY_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('todoist', 'oauth', 'auth-code', ARRAY['TODOIST_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('xero', 'oauth', 'auth-code', ARRAY['XERO_ACCESS_TOKEN', 'XERO_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('airtable', 'oauth', 'auth-code', ARRAY['AIRTABLE_ACCESS_TOKEN', 'AIRTABLE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('docusign', 'oauth', 'auth-code', ARRAY['DOCUSIGN_ACCESS_TOKEN', 'DOCUSIGN_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-ads', 'oauth', 'auth-code', ARRAY['GOOGLE_ADS_ACCESS_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-cloud', 'oauth', 'auth-code', ARRAY['GOOGLE_CLOUD_ACCESS_TOKEN', 'GOOGLE_CLOUD_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('google-maps', 'oauth', 'auth-code', ARRAY['GOOGLE_MAPS_ACCESS_TOKEN', 'GOOGLE_MAPS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('gumroad', 'oauth', 'auth-code', ARRAY['GUMROAD_ACCESS_TOKEN', 'GUMROAD_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('gumroad', 'api-token', 'manual', ARRAY['GUMROAD_TOKEN'], ARRAY[]::text[]),
    ('nintendo-switch-parental-controls', 'api', 'external-code', ARRAY['NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN', 'NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN', 'NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN', 'NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID'], ARRAY['NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_ID', 'NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG', 'NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE']),
    ('nintendo-store', 'api', 'external-code', ARRAY['NINTENDO_STORE_ACCESS_TOKEN', 'NINTENDO_STORE_ID_TOKEN', 'NINTENDO_STORE_SESSION_TOKEN'], ARRAY['NINTENDO_STORE_ACCOUNT_ID', 'NINTENDO_STORE_LOCALE']),
    ('playstation', 'api', 'external-code', ARRAY['PLAYSTATION_ACCESS_TOKEN', 'PLAYSTATION_ID_TOKEN', 'PLAYSTATION_REFRESH_TOKEN'], ARRAY['PLAYSTATION_ACCOUNT_ID', 'PLAYSTATION_ONLINE_ID']),
    ('spotify', 'oauth', 'auth-code', ARRAY['SPOTIFY_ACCESS_TOKEN', 'SPOTIFY_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('steam', 'openid', 'openid-auth', ARRAY[]::text[], ARRAY['STEAM_ID']),
    ('agentmail', 'api-token', 'manual', ARRAY['AGENTMAIL_TOKEN'], ARRAY[]::text[]),
    ('archer', 'api-token', 'manual', ARRAY['ARCHER_API_KEY'], ARRAY[]::text[]),
    ('ardent', 'api-token', 'manual', ARRAY['ARDENT_API_KEY'], ARRAY[]::text[]),
    ('arga-labs', 'api-token', 'manual', ARRAY['ARGA_LABS_API_KEY'], ARRAY[]::text[]),
    ('armature', 'api-token', 'manual', ARRAY['ARMATURE_API_KEY'], ARRAY[]::text[]),
    ('bentolabs-ai', 'api-token', 'manual', ARRAY['BENTOLABS_AI_API_KEY'], ARRAY[]::text[]),
    ('bloom', 'api-token', 'manual', ARRAY['BLOOM_API_KEY'], ARRAY[]::text[]),
    ('chert', 'api-token', 'manual', ARRAY['CHERT_API_KEY'], ARRAY[]::text[]),
    ('inth', 'api-token', 'manual', ARRAY['INTH_API_KEY'], ARRAY[]::text[]),
    ('insforge', 'api-token', 'manual', ARRAY['INSFORGE_API_KEY'], ARRAY['INSFORGE_DOMAIN']),
    ('interfaze', 'api-token', 'manual', ARRAY['INTERFAZE_API_KEY'], ARRAY[]::text[]),
    ('keyframe-labs', 'api-token', 'manual', ARRAY['KEYFRAME_LABS_API_KEY'], ARRAY[]::text[]),
    ('kugelaudio', 'api-token', 'manual', ARRAY['KUGELAUDIO_API_KEY'], ARRAY[]::text[]),
    ('limrun', 'api-token', 'manual', ARRAY['LIMRUN_API_KEY'], ARRAY[]::text[]),
    ('minicor', 'api-token', 'manual', ARRAY['MINICOR_API_KEY'], ARRAY[]::text[]),
    ('netter', 'api-token', 'manual', ARRAY['NETTER_API_KEY'], ARRAY[]::text[]),
    ('oddpool', 'api-token', 'manual', ARRAY['ODDPOOL_API_KEY'], ARRAY[]::text[]),
    ('primitive', 'api-token', 'manual', ARRAY['PRIMITIVE_API_KEY'], ARRAY[]::text[]),
    ('qomplement', 'api-token', 'manual', ARRAY['QOMPLEMENT_API_KEY'], ARRAY[]::text[]),
    ('rentahuman', 'api-token', 'manual', ARRAY['RENTAHUMAN_API_KEY'], ARRAY[]::text[]),
    ('replicas', 'api-token', 'manual', ARRAY['REPLICAS_API_KEY'], ARRAY[]::text[]),
    ('river-markets', 'api-token', 'manual', ARRAY['RIVER_MARKETS_API_KEY'], ARRAY[]::text[]),
    ('runtime', 'api-token', 'manual', ARRAY['RUNTIME_API_KEY'], ARRAY[]::text[]),
    ('salesgraph', 'api-token', 'manual', ARRAY['SALESGRAPH_API_KEY'], ARRAY[]::text[]),
    ('silmaril', 'api-token', 'manual', ARRAY['SILMARIL_API_KEY'], ARRAY[]::text[]),
    ('smol-machines', 'api-token', 'manual', ARRAY['SMOL_MACHINES_API_KEY'], ARRAY[]::text[]),
    ('stablebrowse', 'api-token', 'manual', ARRAY['STABLEBROWSE_API_KEY'], ARRAY[]::text[]),
    ('testerarmy', 'api-token', 'manual', ARRAY['TESTERARMY_API_KEY'], ARRAY[]::text[]),
    ('totalis', 'api-token', 'manual', ARRAY['TOTALIS_API_KEY'], ARRAY[]::text[]),
    ('trellis', 'api-token', 'manual', ARRAY['TRELLIS_API_KEY'], ARRAY[]::text[]),
    ('voquill', 'api-token', 'manual', ARRAY['VOQUILL_API_KEY'], ARRAY[]::text[]),
    ('agora', 'api-token', 'manual', ARRAY['AGORA_APP_CERTIFICATE', 'AGORA_CUSTOMER_ID', 'AGORA_CUSTOMER_SECRET'], ARRAY['AGORA_APP_ID']),
    ('ahrefs', 'oauth', 'auth-code', ARRAY['AHREFS_ACCESS_TOKEN', 'AHREFS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('ahrefs', 'api-token', 'manual', ARRAY['AHREFS_TOKEN'], ARRAY[]::text[]),
    ('adzuna', 'api-token', 'manual', ARRAY['ADZUNA_APP_KEY'], ARRAY['ADZUNA_APP_ID']),
    ('altium-365', 'api-token', 'manual', ARRAY['ALTIUM365_TOKEN'], ARRAY['ALTIUM365_WORKSPACE_URL']),
    ('alchemy', 'api-token', 'manual', ARRAY['ALCHEMY_API_KEY'], ARRAY[]::text[]),
    ('amplitude', 'api-token', 'manual', ARRAY['AMPLITUDE_API_KEY', 'AMPLITUDE_SECRET_KEY'], ARRAY[]::text[]),
    ('amadeus', 'api-token', 'manual', ARRAY['AMADEUS_API_KEY', 'AMADEUS_API_SECRET'], ARRAY[]::text[]),
    ('anthropic-managed-agents', 'api-token', 'manual', ARRAY['ANTHROPIC_MANAGED_AGENTS_TOKEN'], ARRAY[]::text[]),
    ('apify', 'api-token', 'manual', ARRAY['APIFY_TOKEN'], ARRAY[]::text[]),
    ('apollo', 'api-token', 'manual', ARRAY['APOLLO_TOKEN'], ARRAY[]::text[]),
    ('asana', 'oauth', 'auth-code', ARRAY['ASANA_ACCESS_TOKEN', 'ASANA_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('ashby', 'api-token', 'manual', ARRAY['ASHBY_TOKEN'], ARRAY[]::text[]),
    ('atlassian', 'api-token', 'manual', ARRAY['ATLASSIAN_TOKEN'], ARRAY['ATLASSIAN_DOMAIN', 'ATLASSIAN_EMAIL']),
    ('attio', 'api-token', 'manual', ARRAY['ATTIO_TOKEN'], ARRAY[]::text[]),
    ('atlascloud', 'api-token', 'manual', ARRAY['ATLASCLOUD_API_KEY'], ARRAY[]::text[]),
    ('aviationstack', 'api-token', 'manual', ARRAY['AVIATIONSTACK_TOKEN'], ARRAY[]::text[]),
    ('aws', 'cli', 'external-code', ARRAY['AWS_ACCESS_KEY_ID', 'AWS_LOGIN_DPOP_KEY', 'AWS_LOGIN_REFRESH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'], ARRAY['AWS_REGION', 'AWS_SIGNIN_REGION']),
    ('axiom', 'api-token', 'manual', ARRAY['AXIOM_TOKEN'], ARRAY[]::text[]),
    ('base44', 'oauth', 'device-auth', ARRAY['BASE44_ACCESS_TOKEN', 'BASE44_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('bentoml', 'api-token', 'manual', ARRAY['BENTO_CLOUD_API_KEY'], ARRAY['BENTO_CLOUD_API_ENDPOINT']),
    ('bfl', 'api-token', 'manual', ARRAY['BFL_API_KEY'], ARRAY[]::text[]),
    ('bitrefill', 'api-token', 'manual', ARRAY['BITREFILL_TOKEN'], ARRAY[]::text[]),
    ('bitrix', 'api-token', 'manual', ARRAY['BITRIX_WEBHOOK_URL'], ARRAY[]::text[]),
    ('bland', 'api-token', 'manual', ARRAY['BLAND_API_KEY'], ARRAY[]::text[]),
    ('box', 'oauth', 'auth-code', ARRAY['BOX_ACCESS_TOKEN', 'BOX_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('brave-search', 'api-token', 'manual', ARRAY['BRAVE_API_KEY'], ARRAY[]::text[]),
    ('brex', 'api-token', 'manual', ARRAY['BREX_TOKEN'], ARRAY[]::text[]),
    ('brevo', 'api-token', 'manual', ARRAY['BREVO_TOKEN'], ARRAY[]::text[]),
    ('bright-data', 'api-token', 'manual', ARRAY['BRIGHTDATA_TOKEN'], ARRAY[]::text[]),
    ('browserbase', 'api-token', 'manual', ARRAY['BROWSERBASE_TOKEN'], ARRAY['BROWSERBASE_PROJECT_ID']),
    ('browserless', 'api-token', 'manual', ARRAY['BROWSERLESS_TOKEN'], ARRAY[]::text[]),
    ('browserstack', 'api-token', 'manual', ARRAY['BROWSERSTACK_ACCESS_KEY', 'BROWSERSTACK_USERNAME'], ARRAY[]::text[]),
    ('browser-use', 'api-token', 'manual', ARRAY['BROWSER_USE_TOKEN'], ARRAY[]::text[]),
    ('bubblemaps', 'api-token', 'manual', ARRAY['BUBBLEMAPS_API_KEY'], ARRAY[]::text[]),
    ('buffer', 'api-token', 'manual', ARRAY['BUFFER_TOKEN'], ARRAY[]::text[]),
    ('builtwith', 'api-token', 'manual', ARRAY['BUILTWITH_TOKEN'], ARRAY[]::text[]),
    ('cal-com', 'api-token', 'manual', ARRAY['CALCOM_TOKEN'], ARRAY[]::text[]),
    ('calendly', 'api-token', 'manual', ARRAY['CALENDLY_TOKEN'], ARRAY[]::text[]),
    ('canva', 'oauth', 'auth-code', ARRAY['CANVA_ACCESS_TOKEN', 'CANVA_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('chatwoot', 'api-token', 'manual', ARRAY['CHATWOOT_TOKEN'], ARRAY[]::text[]),
    ('checkr', 'api-token', 'manual', ARRAY['CHECKR_TOKEN'], ARRAY[]::text[]),
    ('clado', 'api-token', 'manual', ARRAY['CLADO_TOKEN'], ARRAY[]::text[]),
    ('clerk', 'api-token', 'manual', ARRAY['CLERK_TOKEN'], ARRAY[]::text[]),
    ('clearbit', 'api-token', 'manual', ARRAY['CLEARBIT_TOKEN'], ARRAY[]::text[]),
    ('clickup', 'api-token', 'manual', ARRAY['CLICKUP_TOKEN'], ARRAY[]::text[]),
    ('close', 'oauth', 'auth-code', ARRAY['CLOSE_ACCESS_TOKEN', 'CLOSE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('cloudflare', 'oauth', 'auth-code', ARRAY['CLOUDFLARE_ACCESS_TOKEN', 'CLOUDFLARE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('cloudflare', 'api-token', 'manual', ARRAY['CLOUDFLARE_TOKEN'], ARRAY[]::text[]),
    ('cloudinary', 'api-token', 'manual', ARRAY['CLOUDINARY_API_SECRET', 'CLOUDINARY_TOKEN'], ARRAY['CLOUDINARY_CLOUD_NAME']),
    ('coda', 'api-token', 'manual', ARRAY['CODA_TOKEN'], ARRAY[]::text[]),
    ('coingecko', 'api-token', 'manual', ARRAY['COINGECKO_TOKEN'], ARRAY[]::text[]),
    ('coresignal', 'api-token', 'manual', ARRAY['CORESIGNAL_TOKEN'], ARRAY[]::text[]),
    ('cronlytic', 'api-token', 'manual', ARRAY['CRONLYTIC_API_KEY'], ARRAY['CRONLYTIC_USER_ID']),
    ('crustdata', 'api-token', 'manual', ARRAY['CRUSTDATA_TOKEN'], ARRAY[]::text[]),
    ('cursor', 'api-token', 'manual', ARRAY['CURSOR_TOKEN'], ARRAY[]::text[]),
    ('customer-io', 'api-token', 'manual', ARRAY['CUSTOMERIO_APP_TOKEN'], ARRAY[]::text[]),
    ('daytona', 'api-token', 'manual', ARRAY['DAYTONA_API_KEY'], ARRAY[]::text[]),
    ('db9', 'api-token', 'manual', ARRAY['DB9_API_KEY'], ARRAY[]::text[]),
    ('deel', 'oauth', 'auth-code', ARRAY['DEEL_ACCESS_TOKEN', 'DEEL_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('deel', 'api-token', 'manual', ARRAY['DEEL_TOKEN'], ARRAY[]::text[]),
    ('defillama', 'api-token', 'manual', ARRAY['DEFILLAMA_TOKEN'], ARRAY[]::text[]),
    ('deepseek', 'api-token', 'manual', ARRAY['DEEPSEEK_TOKEN'], ARRAY[]::text[]),
    ('devto', 'api-token', 'manual', ARRAY['DEVTO_TOKEN'], ARRAY[]::text[]),
    ('diffbot', 'api-token', 'manual', ARRAY['DIFFBOT_TOKEN'], ARRAY[]::text[]),
    ('dify', 'api-token', 'manual', ARRAY['DIFY_TOKEN'], ARRAY[]::text[]),
    ('discord', 'api-token', 'manual', ARRAY['DISCORD_BOT_TOKEN'], ARRAY[]::text[]),
    ('discord-webhook', 'api-token', 'manual', ARRAY['DISCORD_WEBHOOK_URL'], ARRAY[]::text[]),
    ('doppler', 'api-token', 'manual', ARRAY['DOPPLER_TOKEN'], ARRAY[]::text[]),
    ('doubao', 'api-token', 'manual', ARRAY['DOUBAO_API_KEY'], ARRAY[]::text[]),
    ('drive9', 'api-token', 'manual', ARRAY['DRIVE9_TOKEN'], ARRAY[]::text[]),
    ('dropbox', 'oauth', 'auth-code', ARRAY['DROPBOX_ACCESS_TOKEN', 'DROPBOX_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('dropbox', 'api-token', 'manual', ARRAY['DROPBOX_TOKEN'], ARRAY[]::text[]),
    ('dropbox-sign', 'api-token', 'manual', ARRAY['DROPBOX_SIGN_TOKEN'], ARRAY[]::text[]),
    ('duffel', 'api-token', 'manual', ARRAY['DUFFEL_TOKEN'], ARRAY[]::text[]),
    ('e2b', 'api-token', 'manual', ARRAY['E2B_TOKEN'], ARRAY[]::text[]),
    ('elevenlabs', 'api-token', 'manual', ARRAY['ELEVENLABS_TOKEN'], ARRAY[]::text[]),
    ('etsy', 'api-token', 'manual', ARRAY['ETSY_TOKEN'], ARRAY[]::text[]),
    ('etherscan', 'api-token', 'manual', ARRAY['ETHERSCAN_API_KEY'], ARRAY[]::text[]),
    ('exa', 'api-token', 'manual', ARRAY['EXA_TOKEN'], ARRAY[]::text[]),
    ('explorium', 'api-token', 'manual', ARRAY['EXPLORIUM_TOKEN'], ARRAY[]::text[]),
    ('faire', 'api-token', 'manual', ARRAY['FAIRE_TOKEN'], ARRAY[]::text[]),
    ('fal', 'api-token', 'manual', ARRAY['FAL_TOKEN'], ARRAY[]::text[]),
    ('figma', 'oauth', 'auth-code', ARRAY['FIGMA_ACCESS_TOKEN', 'FIGMA_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('figma', 'api-token', 'manual', ARRAY['FIGMA_TOKEN'], ARRAY[]::text[]),
    ('firecrawl', 'api-token', 'manual', ARRAY['FIRECRAWL_TOKEN'], ARRAY[]::text[]),
    ('fireflies', 'api-token', 'manual', ARRAY['FIREFLIES_TOKEN'], ARRAY[]::text[]),
    ('flightaware', 'api-token', 'manual', ARRAY['FLIGHTAWARE_TOKEN'], ARRAY[]::text[]),
    ('freshdesk', 'api-token', 'manual', ARRAY['FRESHDESK_TOKEN'], ARRAY['FRESHDESK_DOMAIN']),
    ('gamma', 'api-token', 'manual', ARRAY['GAMMA_TOKEN'], ARRAY[]::text[]),
    ('garmin-connect', 'oauth', 'auth-code', ARRAY['GARMIN_CONNECT_ACCESS_TOKEN', 'GARMIN_CONNECT_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('gemini', 'api-token', 'manual', ARRAY['GEMINI_TOKEN'], ARRAY[]::text[]),
    ('gitlab', 'api-token', 'manual', ARRAY['GITLAB_TOKEN'], ARRAY['GITLAB_HOST']),
    ('gong', 'api-token', 'manual', ARRAY['GONG_ACCESS_KEY', 'GONG_ACCESS_KEY_SECRET'], ARRAY['GONG_API_BASE']),
    ('granola', 'api-token', 'manual', ARRAY['GRANOLA_TOKEN'], ARRAY[]::text[]),
    ('greenhouse', 'api-token', 'manual', ARRAY['GREENHOUSE_TOKEN'], ARRAY[]::text[]),
    ('groq', 'api-token', 'manual', ARRAY['GROQ_TOKEN'], ARRAY[]::text[]),
    ('helicone', 'api-token', 'manual', ARRAY['HELICONE_TOKEN'], ARRAY[]::text[]),
    ('heygen', 'api-token', 'manual', ARRAY['HEYGEN_TOKEN'], ARRAY[]::text[]),
    ('hitem3d', 'api-token', 'manual', ARRAY['HITEM3D_CLIENT_ID', 'HITEM3D_CLIENT_SECRET'], ARRAY[]::text[]),
    ('htmlcsstoimage', 'api-token', 'manual', ARRAY['HCTI_API_KEY'], ARRAY['HCTI_USER_ID']),
    ('honcho', 'api-token', 'manual', ARRAY['HONCHO_API_KEY'], ARRAY[]::text[]),
    ('hugging-face', 'api-token', 'manual', ARRAY['HUGGING_FACE_TOKEN'], ARRAY[]::text[]),
    ('hume', 'api-token', 'manual', ARRAY['HUME_TOKEN'], ARRAY[]::text[]),
    ('hunter', 'api-token', 'manual', ARRAY['HUNTER_TOKEN'], ARRAY[]::text[]),
    ('imgur', 'api-token', 'manual', ARRAY['IMGUR_CLIENT_ID'], ARRAY[]::text[]),
    ('infisical', 'api-token', 'manual', ARRAY['INFISICAL_TOKEN'], ARRAY[]::text[]),
    ('instagram', 'api-token', 'manual', ARRAY['INSTAGRAM_TOKEN'], ARRAY['INSTAGRAM_BUSINESS_ACCOUNT_ID']),
    ('instantly', 'api-token', 'manual', ARRAY['INSTANTLY_API_KEY'], ARRAY[]::text[]),
    ('intercom', 'api-token', 'manual', ARRAY['INTERCOM_TOKEN'], ARRAY[]::text[]),
    ('ironclad', 'api-token', 'manual', ARRAY['IRONCLAD_API_KEY'], ARRAY['IRONCLAD_HOST']),
    ('jam', 'api-token', 'manual', ARRAY['JAM_TOKEN'], ARRAY[]::text[]),
    ('jira', 'api-token', 'manual', ARRAY['JIRA_API_TOKEN'], ARRAY['JIRA_DOMAIN', 'JIRA_EMAIL']),
    ('jotform', 'api-token', 'manual', ARRAY['JOTFORM_TOKEN'], ARRAY[]::text[]),
    ('klaviyo', 'api-token', 'manual', ARRAY['KLAVIYO_TOKEN'], ARRAY[]::text[]),
    ('kommo', 'api-token', 'manual', ARRAY['KOMMO_API_KEY'], ARRAY['KOMMO_SUBDOMAIN']),
    ('langfuse', 'api-token', 'manual', ARRAY['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'], ARRAY[]::text[]),
    ('langsmith', 'api-token', 'manual', ARRAY['LANGSMITH_TOKEN'], ARRAY[]::text[]),
    ('lark', 'api-token', 'manual', ARRAY['LARK_ACCESS_TOKEN', 'LARK_APP_SECRET'], ARRAY['LARK_APP_ID']),
    ('line', 'api-token', 'manual', ARRAY['LINE_TOKEN'], ARRAY[]::text[]),
    ('loops', 'api-token', 'manual', ARRAY['LOOPS_TOKEN'], ARRAY[]::text[]),
    ('luma', 'api-token', 'manual', ARRAY['LUMA_API_KEY'], ARRAY[]::text[]),
    ('luma-ai', 'api-token', 'manual', ARRAY['LUMA_TOKEN'], ARRAY[]::text[]),
    ('mailchimp', 'oauth', 'auth-code', ARRAY['MAILCHIMP_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('mailchimp', 'api-token', 'manual', ARRAY['MAILCHIMP_TOKEN'], ARRAY[]::text[]),
    ('mailsac', 'api-token', 'manual', ARRAY['MAILSAC_TOKEN'], ARRAY[]::text[]),
    ('make', 'api-token', 'manual', ARRAY['MAKE_TOKEN'], ARRAY[]::text[]),
    ('manus', 'api-token', 'manual', ARRAY['MANUS_TOKEN'], ARRAY[]::text[]),
    ('mapbox', 'api-token', 'manual', ARRAY['MAPBOX_TOKEN'], ARRAY[]::text[]),
    ('massive', 'api-token', 'manual', ARRAY['MASSIVE_TOKEN'], ARRAY[]::text[]),
    ('maskdb', 'api-token', 'manual', ARRAY['MASKDB_TOKEN'], ARRAY[]::text[]),
    ('mathpix', 'api-token', 'manual', ARRAY['MATHPIX_APP_KEY'], ARRAY['MATHPIX_APP_ID']),
    ('mem0', 'api-token', 'manual', ARRAY['MEM0_TOKEN'], ARRAY[]::text[]),
    ('mercury', 'oauth', 'auth-code', ARRAY['MERCURY_ACCESS_TOKEN', 'MERCURY_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('mercury', 'api-token', 'manual', ARRAY['MERCURY_TOKEN'], ARRAY[]::text[]),
    ('meshy', 'api-token', 'manual', ARRAY['MESHY_API_KEY'], ARRAY[]::text[]),
    ('meta-ads', 'oauth', 'auth-code', ARRAY['META_ADS_ACCESS_TOKEN', 'META_ADS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('metabase', 'api-token', 'manual', ARRAY['METABASE_TOKEN'], ARRAY['METABASE_BASE_URL']),
    ('microsoft-365', 'oauth', 'auth-code', ARRAY['MICROSOFT_365_ACCESS_TOKEN', 'MICROSOFT_365_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('tiktok-ads', 'oauth', 'auth-code', ARRAY['TIKTOK_ADS_ACCESS_TOKEN', 'TIKTOK_ADS_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('minimax', 'api-token', 'manual', ARRAY['MINIMAX_TOKEN'], ARRAY[]::text[]),
    ('minio', 'api-token', 'manual', ARRAY['MINIO_SECRET_TOKEN', 'MINIO_TOKEN'], ARRAY['MINIO_ENDPOINT']),
    ('miro', 'api-token', 'manual', ARRAY['MIRO_TOKEN'], ARRAY[]::text[]),
    ('mixpanel', 'api-token', 'manual', ARRAY['MIXPANEL_SERVICE_ACCOUNT_SECRET', 'MIXPANEL_SERVICE_ACCOUNT_USERNAME'], ARRAY['MIXPANEL_PROJECT_ID']),
    ('monday', 'oauth', 'auth-code', ARRAY['MONDAY_ACCESS_TOKEN', 'MONDAY_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('modal', 'api-token', 'manual', ARRAY['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], ARRAY['MODAL_ENVIRONMENT']),
    ('moss', 'api-token', 'manual', ARRAY['MOSS_PROJECT_ID', 'MOSS_PROJECT_KEY'], ARRAY[]::text[]),
    ('msg9', 'api-token', 'manual', ARRAY['MSG9_TOKEN'], ARRAY[]::text[]),
    ('n8n', 'api-token', 'manual', ARRAY['N8N_TOKEN'], ARRAY['N8N_BASE_URL']),
    ('neon', 'oauth', 'auth-code', ARRAY['NEON_ACCESS_TOKEN', 'NEON_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('neon', 'api-token', 'manual', ARRAY['NEON_TOKEN'], ARRAY[]::text[]),
    ('netdata', 'api-token', 'manual', ARRAY['NETDATA_TOKEN'], ARRAY[]::text[]),
    ('novita', 'api-token', 'manual', ARRAY['NOVITA_TOKEN'], ARRAY[]::text[]),
    ('nyne', 'api-token', 'manual', ARRAY['NYNE_API_KEY', 'NYNE_API_SECRET'], ARRAY[]::text[]),
    ('onyx', 'api-token', 'manual', ARRAY['ONYX_TOKEN'], ARRAY[]::text[]),
    ('openai', 'api-token', 'manual', ARRAY['OPENAI_TOKEN'], ARRAY[]::text[]),
    ('openrouter', 'api-token', 'manual', ARRAY['OPENROUTER_TOKEN'], ARRAY[]::text[]),
    ('openweather', 'api-token', 'manual', ARRAY['OPENWEATHER_TOKEN'], ARRAY[]::text[]),
    ('outlook-calendar', 'oauth', 'auth-code', ARRAY['OUTLOOK_CALENDAR_ACCESS_TOKEN', 'OUTLOOK_CALENDAR_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('outlook-mail', 'oauth', 'auth-code', ARRAY['OUTLOOK_MAIL_ACCESS_TOKEN', 'OUTLOOK_MAIL_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('pandadoc', 'api-token', 'manual', ARRAY['PANDADOC_TOKEN'], ARRAY[]::text[]),
    ('parallel', 'api-token', 'manual', ARRAY['PARALLEL_API_KEY'], ARRAY[]::text[]),
    ('pdf4me', 'api-token', 'manual', ARRAY['PDF4ME_TOKEN'], ARRAY[]::text[]),
    ('pdfco', 'api-token', 'manual', ARRAY['PDFCO_TOKEN'], ARRAY[]::text[]),
    ('pdforge', 'api-token', 'manual', ARRAY['PDFORGE_API_KEY'], ARRAY[]::text[]),
    ('people-data-labs', 'api-token', 'manual', ARRAY['PEOPLE_DATA_LABS_API_KEY'], ARRAY[]::text[]),
    ('perplexity', 'api-token', 'manual', ARRAY['PERPLEXITY_TOKEN'], ARRAY[]::text[]),
    ('pexels', 'api-token', 'manual', ARRAY['PEXELS_API_KEY'], ARRAY[]::text[]),
    ('pika', 'api-token', 'manual', ARRAY['PIKA_TOKEN'], ARRAY[]::text[]),
    ('pinecone', 'api-token', 'manual', ARRAY['PINECONE_TOKEN'], ARRAY[]::text[]),
    ('pipedream', 'api-token', 'manual', ARRAY['PIPEDREAM_TOKEN'], ARRAY[]::text[]),
    ('pipedrive', 'api-token', 'manual', ARRAY['PIPEDRIVE_TOKEN'], ARRAY[]::text[]),
    ('plain', 'api-token', 'manual', ARRAY['PLAIN_TOKEN'], ARRAY[]::text[]),
    ('plausible', 'api-token', 'manual', ARRAY['PLAUSIBLE_TOKEN'], ARRAY[]::text[]),
    ('podchaser', 'api-token', 'manual', ARRAY['PODCHASER_TOKEN'], ARRAY[]::text[]),
    ('posthog', 'oauth', 'auth-code', ARRAY['POSTHOG_ACCESS_TOKEN', 'POSTHOG_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('posthog', 'api-token', 'manual', ARRAY['POSTHOG_TOKEN'], ARRAY[]::text[]),
    ('porkbun', 'api-token', 'manual', ARRAY['PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY'], ARRAY[]::text[]),
    ('printful', 'api-token', 'manual', ARRAY['PRINTFUL_TOKEN'], ARRAY[]::text[]),
    ('prisma-postgres', 'api-token', 'manual', ARRAY['PRISMA_POSTGRES_TOKEN'], ARRAY[]::text[]),
    ('profound', 'api-token', 'manual', ARRAY['PROFOUND_API_KEY'], ARRAY[]::text[]),
    ('productlane', 'api-token', 'manual', ARRAY['PRODUCTLANE_TOKEN'], ARRAY[]::text[]),
    ('pushinator', 'api-token', 'manual', ARRAY['PUSHINATOR_TOKEN'], ARRAY[]::text[]),
    ('qdrant', 'api-token', 'manual', ARRAY['QDRANT_TOKEN'], ARRAY['QDRANT_BASE_URL']),
    ('quickbooks', 'oauth', 'auth-code', ARRAY['QUICKBOOKS_ACCESS_TOKEN', 'QUICKBOOKS_REFRESH_TOKEN'], ARRAY['QUICKBOOKS_REALM_ID']),
    ('qiita', 'api-token', 'manual', ARRAY['QIITA_TOKEN'], ARRAY[]::text[]),
    ('railway', 'api-token', 'manual', ARRAY['RAILWAY_TOKEN'], ARRAY[]::text[]),
    ('railway-project', 'api-token', 'manual', ARRAY['RAILWAY_PROJECT_TOKEN'], ARRAY[]::text[]),
    ('reap', 'api-token', 'manual', ARRAY['REAP_API_KEY'], ARRAY['REAP_API_BASE_URL']),
    ('reddit', 'oauth', 'auth-code', ARRAY['REDDIT_ACCESS_TOKEN', 'REDDIT_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('reducto', 'api-token', 'manual', ARRAY['REDUCTO_TOKEN'], ARRAY[]::text[]),
    ('recraft', 'api-token', 'manual', ARRAY['RECRAFT_API_TOKEN'], ARRAY[]::text[]),
    ('render', 'api-token', 'manual', ARRAY['RENDER_API_KEY'], ARRAY[]::text[]),
    ('replicate', 'api-token', 'manual', ARRAY['REPLICATE_TOKEN'], ARRAY[]::text[]),
    ('reportei', 'api-token', 'manual', ARRAY['REPORTEI_TOKEN'], ARRAY[]::text[]),
    ('resend', 'api-token', 'manual', ARRAY['RESEND_TOKEN'], ARRAY[]::text[]),
    ('rentcast', 'api-token', 'manual', ARRAY['RENTCAST_API_KEY'], ARRAY[]::text[]),
    ('revenuecat', 'api-token', 'manual', ARRAY['REVENUECAT_TOKEN'], ARRAY[]::text[]),
    ('runway', 'api-token', 'manual', ARRAY['RUNWAY_TOKEN'], ARRAY[]::text[]),
    ('salesforce', 'api-token', 'manual', ARRAY['SALESFORCE_TOKEN'], ARRAY['SALESFORCE_INSTANCE']),
    ('scrapeninja', 'api-token', 'manual', ARRAY['SCRAPENINJA_TOKEN'], ARRAY[]::text[]),
    ('segment', 'api-token', 'manual', ARRAY['SEGMENT_TOKEN'], ARRAY[]::text[]),
    ('semrush', 'api-token', 'manual', ARRAY['SEMRUSH_TOKEN'], ARRAY[]::text[]),
    ('sendgrid', 'api-token', 'manual', ARRAY['SENDGRID_TOKEN'], ARRAY[]::text[]),
    ('serpapi', 'api-token', 'manual', ARRAY['SERPAPI_TOKEN'], ARRAY[]::text[]),
    ('servicenow', 'api-token', 'manual', ARRAY['SERVICENOW_PASSWORD', 'SERVICENOW_USERNAME'], ARRAY['SERVICENOW_INSTANCE']),
    ('shopify', 'api-token', 'manual', ARRAY['SHOPIFY_TOKEN'], ARRAY['SHOPIFY_SHOP']),
    ('shortio', 'api-token', 'manual', ARRAY['SHORTIO_TOKEN'], ARRAY[]::text[]),
    ('similarweb', 'api-token', 'manual', ARRAY['SIMILARWEB_TOKEN'], ARRAY[]::text[]),
    ('slack-webhook', 'api-token', 'manual', ARRAY['SLACK_WEBHOOK_URL'], ARRAY[]::text[]),
    ('snowflake', 'api-token', 'manual', ARRAY['SNOWFLAKE_PAT'], ARRAY['SNOWFLAKE_ACCOUNT']),
    ('sociavault', 'api-token', 'manual', ARRAY['SOCIAVAULT_TOKEN'], ARRAY[]::text[]),
    ('sponge', 'api-token', 'manual', ARRAY['SPONGE_MASTER_KEY'], ARRAY[]::text[]),
    ('sproutgigs', 'api-token', 'manual', ARRAY['SPROUTGIGS_API_SECRET'], ARRAY['SPROUTGIGS_USER_ID']),
    ('square', 'api-token', 'manual', ARRAY['SQUARE_TOKEN'], ARRAY[]::text[]),
    ('stability-ai', 'api-token', 'manual', ARRAY['STABILITY_TOKEN'], ARRAY[]::text[]),
    ('strapi', 'api-token', 'manual', ARRAY['STRAPI_TOKEN'], ARRAY['STRAPI_BASE_URL']),
    ('streak', 'api-token', 'manual', ARRAY['STREAK_TOKEN'], ARRAY[]::text[]),
    ('stripe', 'oauth', 'auth-code', ARRAY['STRIPE_ACCESS_TOKEN', 'STRIPE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('stripe', 'cli', 'device-auth', ARRAY['STRIPE_TOKEN'], ARRAY[]::text[]),
    ('stripe', 'api-token', 'manual', ARRAY['STRIPE_TOKEN'], ARRAY[]::text[]),
    ('supabase', 'oauth', 'auth-code', ARRAY['SUPABASE_ACCESS_TOKEN', 'SUPABASE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('supabase', 'api-token', 'manual', ARRAY['SUPABASE_TOKEN'], ARRAY[]::text[]),
    ('supadata', 'api-token', 'manual', ARRAY['SUPADATA_TOKEN'], ARRAY[]::text[]),
    ('supermemory', 'api-token', 'manual', ARRAY['SUPERMEMORY_API_KEY'], ARRAY[]::text[]),
    ('tavily', 'api-token', 'manual', ARRAY['TAVILY_TOKEN'], ARRAY[]::text[]),
    ('test-oauth', 'oauth', 'auth-code', ARRAY['TEST_OAUTH_ACCESS_TOKEN', 'TEST_OAUTH_REFRESH_TOKEN'], ARRAY['TEST_OAUTH_API_TENANT_ID']),
    ('test-oauth', 'api-token', 'manual', ARRAY['TEST_OAUTH_API_TOKEN_ACCESS_TOKEN', 'TEST_OAUTH_TOKEN'], ARRAY['TEST_OAUTH_API_TENANT_ID', 'TEST_OAUTH_API_TOKEN_INPUT_VAR']),
    ('test-oauth', 'api', 'auth-code', ARRAY['TEST_OAUTH_API_ACCESS_TOKEN', 'TEST_OAUTH_API_REFRESH_TOKEN', 'TEST_OAUTH_API_SECONDARY_TOKEN'], ARRAY['TEST_OAUTH_API_TENANT_ID']),
    ('test-oauth-device', 'oauth', 'device-auth', ARRAY['TEST_OAUTH_DEVICE_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('test-oauth-device', 'api', 'device-auth', ARRAY['TEST_OAUTH_DEVICE_API_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('testrail', 'api-token', 'manual', ARRAY['TESTRAIL_EMAIL', 'TESTRAIL_TOKEN'], ARRAY['TESTRAIL_INSTANCE']),
    ('ticketmaster', 'api-token', 'manual', ARRAY['TICKETMASTER_API_KEY'], ARRAY[]::text[]),
    ('tldv', 'api-token', 'manual', ARRAY['TLDV_TOKEN'], ARRAY[]::text[]),
    ('together', 'api-token', 'manual', ARRAY['TOGETHER_TOKEN'], ARRAY[]::text[]),
    ('tripo', 'api-token', 'manual', ARRAY['TRIPO_API_KEY'], ARRAY[]::text[]),
    ('twenty', 'api-token', 'manual', ARRAY['TWENTY_TOKEN'], ARRAY[]::text[]),
    ('twilio', 'api-token', 'manual', ARRAY['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], ARRAY[]::text[]),
    ('typeform', 'api-token', 'manual', ARRAY['TYPEFORM_TOKEN'], ARRAY[]::text[]),
    ('v0', 'api-token', 'manual', ARRAY['V0_TOKEN'], ARRAY[]::text[]),
    ('wandb', 'api-token', 'manual', ARRAY['WANDB_TOKEN'], ARRAY[]::text[]),
    ('webflow', 'oauth', 'auth-code', ARRAY['WEBFLOW_ACCESS_TOKEN'], ARRAY[]::text[]),
    ('webflow', 'api-token', 'manual', ARRAY['WEBFLOW_TOKEN'], ARRAY[]::text[]),
    ('weread', 'api-token', 'manual', ARRAY['WEREAD_TOKEN'], ARRAY[]::text[]),
    ('whale-alert', 'api-token', 'manual', ARRAY['WHALE_ALERT_API_KEY'], ARRAY[]::text[]),
    ('wix', 'api-token', 'manual', ARRAY['WIX_TOKEN'], ARRAY[]::text[]),
    ('workos', 'api-token', 'manual', ARRAY['WORKOS_TOKEN'], ARRAY[]::text[]),
    ('wrike', 'api-token', 'manual', ARRAY['WRIKE_TOKEN'], ARRAY[]::text[]),
    ('youtube', 'oauth', 'auth-code', ARRAY['YOUTUBE_ACCESS_TOKEN', 'YOUTUBE_REFRESH_TOKEN'], ARRAY[]::text[]),
    ('zapier', 'api-token', 'manual', ARRAY['ZAPIER_TOKEN'], ARRAY[]::text[]),
    ('zapsign', 'api-token', 'manual', ARRAY['ZAPSIGN_TOKEN'], ARRAY[]::text[]),
    ('zendesk', 'api-token', 'manual', ARRAY['ZENDESK_API_TOKEN'], ARRAY['ZENDESK_EMAIL', 'ZENDESK_SUBDOMAIN']),
    ('zep', 'api-token', 'manual', ARRAY['ZEP_TOKEN'], ARRAY[]::text[]),
    ('zeptomail', 'api-token', 'manual', ARRAY['ZEPTOMAIL_TOKEN'], ARRAY[]::text[]),
    ('zoom', 'oauth', 'auth-code', ARRAY['ZOOM_ACCESS_TOKEN', 'ZOOM_REFRESH_TOKEN'], ARRAY[]::text[]);
--> statement-breakpoint
-- Connector credentials have no connector foreign key. Preserve a credential only
-- when a supported stored connector identity explicitly owns its name.
DELETE FROM secrets AS credential
WHERE credential.type = 'connector'
  AND NOT EXISTS (
    SELECT 1
    FROM connectors AS connector
    INNER JOIN vm0_supported_connector_identities AS supported
      ON supported.type = connector.type
      AND supported.auth_method = connector.auth_method
    WHERE connector.org_id = credential.org_id
      AND connector.user_id = credential.user_id
      AND credential.name = ANY(supported.secret_names)
  );
--> statement-breakpoint
DELETE FROM variables AS credential
WHERE credential.type = 'connector'
  AND NOT EXISTS (
    SELECT 1
    FROM connectors AS connector
    INNER JOIN vm0_supported_connector_identities AS supported
      ON supported.type = connector.type
      AND supported.auth_method = connector.auth_method
    WHERE connector.org_id = credential.org_id
      AND connector.user_id = credential.user_id
      AND credential.name = ANY(supported.variable_names)
  );
--> statement-breakpoint
DELETE FROM connector_oauth_states AS oauth_state
WHERE NOT EXISTS (
  SELECT 1
  FROM vm0_supported_connector_identities AS supported
  WHERE supported.type = oauth_state.type
    AND supported.auth_method = oauth_state.auth_method
    AND supported.grant_kind IN ('auth-code', 'openid-auth')
);
--> statement-breakpoint
DELETE FROM connector_external_code_sessions AS external_code_session
WHERE NOT EXISTS (
  SELECT 1
  FROM vm0_supported_connector_identities AS supported
  WHERE supported.type = external_code_session.connector_type
    AND supported.auth_method = external_code_session.auth_method
    AND supported.grant_kind = 'external-code'
);
--> statement-breakpoint
DELETE FROM connector_oauth_device_authorization_sessions AS device_session
WHERE NOT EXISTS (
  SELECT 1
  FROM vm0_supported_connector_identities AS supported
  WHERE supported.type = device_session.connector_type
    AND supported.auth_method = device_session.auth_method
    AND supported.grant_kind = 'device-auth'
);
--> statement-breakpoint
DELETE FROM user_connectors AS user_connector
WHERE NOT EXISTS (
  SELECT 1
  FROM vm0_supported_connector_identities AS supported
  WHERE supported.type = user_connector.connector_type
);
--> statement-breakpoint
DELETE FROM user_permission_grants AS permission_grant
WHERE NOT EXISTS (
  SELECT 1
  FROM vm0_supported_connector_identities AS supported
  WHERE supported.type = permission_grant.connector_ref
);
--> statement-breakpoint
DELETE FROM connectors AS connector
WHERE NOT EXISTS (
  SELECT 1
  FROM vm0_supported_connector_identities AS supported
  WHERE supported.type = connector.type
    AND supported.auth_method = connector.auth_method
);
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp.vm0_supported_connector_identities;
