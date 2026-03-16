import type { ConnectorType } from "./connectors";

/**
 * Proxy-side service configuration for token replacement.
 *
 * Defines which base URLs each connector covers and how auth headers
 * are constructed. Used by the proxy to intercept requests matching a
 * connector's base URLs and replace placeholder tokens with real credentials.
 *
 * `${{ secrets.XXX }}` in header values is replaced by the proxy with the real secret value.
 *
 * NOTE: Currently hardcoded in SERVICE_CONFIGS below.
 * Will be migrated to GitHub-hosted connector.yaml definitions in Phase 2.
 */
/**
 * A named permission group with matching rules for request authorization.
 * Rules use the format `METHOD /path` where path is relative to the api entry's base URL.
 */
interface ServicePermission {
  name: string;
  description?: string;
  rules: string[];
}

interface ServiceApi {
  base: string;
  auth: {
    headers: Record<string, string>;
  };
  permissions?: ServicePermission[];
}

export interface ServiceConfig {
  name: string;
  description?: string;
  apis: ServiceApi[];
  /**
   * Custom placeholder values keyed by secret name (matching `${{ secrets.XXX }}` in auth templates).
   * Falls back to auto-generated `VM0_PLACEHOLDER_{secretName}`.
   * Only needed when the service requires a specific credential format (e.g., GitHub's `gho_` prefix).
   */
  placeholders?: Record<string, string>;
}

/**
 * Regex pattern matching `${{ secrets.XXX }}` references in auth header templates.
 * Tolerates optional whitespace inside braces: `${{ secrets.X }}` and `${{secrets.X}}`.
 */
const AUTH_SECRET_PATTERN =
  /\$\{\{\s*secrets\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Extract all secret names referenced in service API auth header templates.
 * E.g., `Bearer ${{ secrets.GITHUB_TOKEN }}` → `["GITHUB_TOKEN"]`
 */
export function extractSecretNamesFromApis(
  apis: ServiceConfig["apis"],
): string[] {
  const names = new Set<string>();
  for (const entry of apis) {
    for (const value of Object.values(entry.auth.headers)) {
      for (const match of value.matchAll(AUTH_SECRET_PATTERN)) {
        names.add(match[1]!);
      }
    }
  }
  return [...names];
}

/** Helper to build standard Bearer auth header with a secret reference. */
function bearerAuth(secretName: string) {
  return { headers: { Authorization: `Bearer \${{ secrets.${secretName} }}` } };
}

/** Default catch-all permission for services without granular permissions. */
const FULL_ACCESS_PERMISSION: ServicePermission = {
  name: "full-access",
  rules: ["ANY /{path+}"],
};

/** Shorthand: single-base API entry with bearer auth. */
function api(base: string, auth: ServiceApi["auth"]): ServiceApi {
  return { base, auth, permissions: [FULL_ACCESS_PERMISSION] };
}

const SERVICE_CONFIGS: Partial<
  Record<ConnectorType, Omit<ServiceConfig, "name">>
> = {
  ahrefs: {
    apis: [api("https://api.ahrefs.com", bearerAuth("AHREFS_TOKEN"))],
  },
  axiom: {
    apis: [api("https://api.axiom.co", bearerAuth("AXIOM_TOKEN"))],
  },
  airtable: {
    apis: [api("https://api.airtable.com", bearerAuth("AIRTABLE_TOKEN"))],
  },
  github: {
    apis: [
      {
        base: "https://api.github.com",
        auth: bearerAuth("GITHUB_TOKEN"),
        permissions: [
          {
            name: "repo-read",
            description: "Read repository metadata, branches, and commits",
            rules: [
              "GET /repos/{owner}/{repo}",
              "GET /repos/{owner}/{repo}/branches",
              "GET /repos/{owner}/{repo}/branches/{branch}",
              "GET /repos/{owner}/{repo}/commits",
              "GET /repos/{owner}/{repo}/commits/{ref}",
              "GET /repos/{owner}/{repo}/contributors",
              "GET /repos/{owner}/{repo}/tags",
              "GET /repos/{owner}/{repo}/releases",
              "GET /repos/{owner}/{repo}/releases/{release_id}",
            ],
          },
          {
            name: "contents-read",
            description: "Read file contents and directory listings",
            rules: [
              "GET /repos/{owner}/{repo}/contents/{path+}",
              "GET /repos/{owner}/{repo}/readme",
              "GET /repos/{owner}/{repo}/git/trees/{sha}",
              "GET /repos/{owner}/{repo}/git/blobs/{sha}",
              "GET /repos/{owner}/{repo}/git/refs/{ref+}",
            ],
          },
          {
            name: "contents-write",
            description: "Create, update, and delete file contents",
            rules: [
              "PUT /repos/{owner}/{repo}/contents/{path+}",
              "DELETE /repos/{owner}/{repo}/contents/{path+}",
              "POST /repos/{owner}/{repo}/git/blobs",
              "POST /repos/{owner}/{repo}/git/trees",
              "POST /repos/{owner}/{repo}/git/commits",
              "POST /repos/{owner}/{repo}/git/refs",
              "PATCH /repos/{owner}/{repo}/git/refs/{ref+}",
            ],
          },
          {
            name: "issues-read",
            description: "Read issues and comments",
            rules: [
              "GET /repos/{owner}/{repo}/issues",
              "GET /repos/{owner}/{repo}/issues/{issue_number}",
              "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
              "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
              "GET /repos/{owner}/{repo}/labels",
            ],
          },
          {
            name: "issues-write",
            description: "Create and update issues, comments, and labels",
            rules: [
              "POST /repos/{owner}/{repo}/issues",
              "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
              "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
              "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
              "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
              "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
            ],
          },
          {
            name: "pull-requests-read",
            description: "Read pull requests, reviews, and diffs",
            rules: [
              "GET /repos/{owner}/{repo}/pulls",
              "GET /repos/{owner}/{repo}/pulls/{pull_number}",
              "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
              "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
              "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
              "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
            ],
          },
          {
            name: "pull-requests-write",
            description: "Create, update, and merge pull requests",
            rules: [
              "POST /repos/{owner}/{repo}/pulls",
              "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
              "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
              "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
              "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
            ],
          },
          {
            name: "actions-read",
            description: "Read workflow runs and logs",
            rules: [
              "GET /repos/{owner}/{repo}/actions/runs",
              "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
              "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
              "GET /repos/{owner}/{repo}/actions/workflows",
              "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
            ],
          },
          {
            name: "user-read",
            description: "Read authenticated user profile and related data",
            rules: [
              "GET /user",
              "GET /user/emails",
              "GET /user/repos",
              "GET /user/orgs",
              "GET /user/teams",
              "GET /user/starred",
              "GET /user/subscriptions",
              "GET /users/{username}",
              "GET /users/{username}/repos",
              "GET /users/{username}/orgs",
            ],
          },
          {
            name: "user-write",
            description: "Update user profile, manage starred repos and email",
            rules: [
              "PATCH /user",
              "POST /user/emails",
              "DELETE /user/emails",
              "PUT /user/starred/{owner}/{repo}",
              "DELETE /user/starred/{owner}/{repo}",
            ],
          },
          {
            name: "search",
            description: "Search code, issues, and repositories",
            rules: [
              "GET /search/code",
              "GET /search/issues",
              "GET /search/repositories",
              "GET /search/commits",
            ],
          },
        ],
      },
    ],
    placeholders: {
      GITHUB_TOKEN: "gho_vm0placeholder0000000000000000000000",
    },
  },
  notion: {
    apis: [
      api("https://api.notion.com/v1", {
        headers: {
          Authorization: "Bearer ${{ secrets.NOTION_TOKEN }}",
          "Notion-Version": "2022-06-28",
        },
      }),
    ],
  },
  gmail: {
    apis: [
      api(
        "https://gmail.googleapis.com/gmail/v1/users/me",
        bearerAuth("GMAIL_TOKEN"),
      ),
    ],
  },
  "google-sheets": {
    apis: [
      api(
        "https://sheets.googleapis.com/v4/spreadsheets",
        bearerAuth("GOOGLE_SHEETS_TOKEN"),
      ),
    ],
  },
  "google-docs": {
    apis: [
      api(
        "https://docs.googleapis.com/v1/documents",
        bearerAuth("GOOGLE_DOCS_TOKEN"),
      ),
    ],
  },
  "google-drive": {
    apis: [
      api(
        "https://www.googleapis.com/drive/v3",
        bearerAuth("GOOGLE_DRIVE_TOKEN"),
      ),
    ],
  },
  "google-calendar": {
    apis: [
      api(
        "https://www.googleapis.com/calendar/v3",
        bearerAuth("GOOGLE_CALENDAR_TOKEN"),
      ),
    ],
  },
  "hugging-face": {
    apis: [api("https://huggingface.co/api", bearerAuth("HUGGING_FACE_TOKEN"))],
  },
  hume: {
    apis: [
      api("https://api.hume.ai", {
        headers: { "X-Hume-Api-Key": "${{ secrets.HUME_TOKEN }}" },
      }),
    ],
  },
  heygen: {
    apis: [
      api("https://api.heygen.com", {
        headers: { "x-api-key": "${{ secrets.HEYGEN_TOKEN }}" },
      }),
    ],
  },
  hubspot: {
    apis: [api("https://api.hubapi.com", bearerAuth("HUBSPOT_TOKEN"))],
  },
  slack: {
    apis: [
      api("https://slack.com/api", bearerAuth("SLACK_TOKEN")),
      api("https://files.slack.com", bearerAuth("SLACK_TOKEN")),
    ],
    placeholders: {
      SLACK_TOKEN: "xoxb-0000-0000-vm0placeholder",
    },
  },
  docusign: {
    apis: [
      api("https://demo.docusign.net/restapi", bearerAuth("DOCUSIGN_TOKEN")),
      api("https://na1.docusign.net/restapi", bearerAuth("DOCUSIGN_TOKEN")),
    ],
  },
  dropbox: {
    apis: [
      api("https://api.dropboxapi.com/2", bearerAuth("DROPBOX_TOKEN")),
      api("https://content.dropboxapi.com/2", bearerAuth("DROPBOX_TOKEN")),
    ],
  },
  linear: {
    apis: [api("https://api.linear.app", bearerAuth("LINEAR_TOKEN"))],
  },
  intercom: {
    apis: [
      api("https://api.intercom.io", bearerAuth("INTERCOM_TOKEN")),
      api("https://api.eu.intercom.io", bearerAuth("INTERCOM_TOKEN")),
      api("https://api.au.intercom.io", bearerAuth("INTERCOM_TOKEN")),
    ],
  },
  jam: {
    apis: [api("https://api.jam.dev", bearerAuth("JAM_TOKEN"))],
  },
  jotform: {
    apis: [
      api("https://api.jotform.com", {
        headers: {
          APIKEY: "${{ secrets.JOTFORM_TOKEN }}",
        },
      }),
      api("https://eu-api.jotform.com", {
        headers: {
          APIKEY: "${{ secrets.JOTFORM_TOKEN }}",
        },
      }),
    ],
  },
  line: {
    apis: [api("https://api.line.me", bearerAuth("LINE_TOKEN"))],
  },
  make: {
    apis: [
      api("https://eu1.make.com/api/v2", {
        headers: {
          Authorization: "Token ${{ secrets.MAKE_TOKEN }}",
        },
      }),
      api("https://eu2.make.com/api/v2", {
        headers: {
          Authorization: "Token ${{ secrets.MAKE_TOKEN }}",
        },
      }),
      api("https://us1.make.com/api/v2", {
        headers: {
          Authorization: "Token ${{ secrets.MAKE_TOKEN }}",
        },
      }),
      api("https://us2.make.com/api/v2", {
        headers: {
          Authorization: "Token ${{ secrets.MAKE_TOKEN }}",
        },
      }),
    ],
  },
  metabase: {
    apis: [
      api("https://api.metabase.com", {
        headers: {
          "x-api-key": "${{ secrets.METABASE_TOKEN }}",
        },
      }),
    ],
  },
  clickup: {
    apis: [api("https://api.clickup.com/api/v2", bearerAuth("CLICKUP_TOKEN"))],
  },
  cloudflare: {
    apis: [
      api(
        "https://api.cloudflare.com/client/v4",
        bearerAuth("CLOUDFLARE_TOKEN"),
      ),
    ],
  },
  deel: {
    apis: [api("https://api.deel.com", bearerAuth("DEEL_TOKEN"))],
  },
  deepseek: {
    apis: [api("https://api.deepseek.com", bearerAuth("DEEPSEEK_TOKEN"))],
  },
  dify: {
    apis: [api("https://api.dify.ai/v1", bearerAuth("DIFY_TOKEN"))],
  },
  figma: {
    apis: [api("https://api.figma.com", bearerAuth("FIGMA_TOKEN"))],
  },
  mercury: {
    apis: [api("https://api.mercury.com", bearerAuth("MERCURY_TOKEN"))],
  },
  minimax: {
    apis: [api("https://api.minimaxi.com/v1", bearerAuth("MINIMAX_TOKEN"))],
  },
  reddit: {
    apis: [api("https://oauth.reddit.com", bearerAuth("REDDIT_TOKEN"))],
  },
  strava: {
    apis: [api("https://www.strava.com/api/v3", bearerAuth("STRAVA_TOKEN"))],
  },
  x: {
    apis: [api("https://api.x.com/2", bearerAuth("X_ACCESS_TOKEN"))],
  },
  neon: {
    apis: [api("https://console.neon.tech/api/v2", bearerAuth("NEON_TOKEN"))],
  },
  vercel: {
    apis: [api("https://api.vercel.com", bearerAuth("VERCEL_TOKEN"))],
  },
  sentry: {
    apis: [api("https://sentry.io/api", bearerAuth("SENTRY_TOKEN"))],
  },
  monday: {
    apis: [api("https://api.monday.com/v2", bearerAuth("MONDAY_TOKEN"))],
  },
  canva: {
    apis: [api("https://api.canva.com/rest/v1", bearerAuth("CANVA_TOKEN"))],
  },
  xero: {
    apis: [api("https://api.xero.com", bearerAuth("XERO_TOKEN"))],
  },
  supabase: {
    apis: [api("https://api.supabase.com/v1", bearerAuth("SUPABASE_TOKEN"))],
  },
  todoist: {
    apis: [api("https://api.todoist.com/rest/v2", bearerAuth("TODOIST_TOKEN"))],
  },
  webflow: {
    apis: [api("https://api.webflow.com/v2", bearerAuth("WEBFLOW_TOKEN"))],
  },
  asana: {
    apis: [api("https://app.asana.com/api/1.0", bearerAuth("ASANA_TOKEN"))],
  },
  "meta-ads": {
    apis: [api("https://graph.facebook.com", bearerAuth("META_ADS_TOKEN"))],
  },
  posthog: {
    apis: [
      api("https://us.posthog.com/api", bearerAuth("POSTHOG_ACCESS_TOKEN")),
      api("https://app.posthog.com/api", bearerAuth("POSTHOG_ACCESS_TOKEN")),
    ],
  },
  stripe: {
    apis: [api("https://api.stripe.com", bearerAuth("STRIPE_TOKEN"))],
  },
  productlane: {
    apis: [
      api("https://productlane.com/api/v1", bearerAuth("PRODUCTLANE_TOKEN")),
    ],
  },
  openai: {
    apis: [api("https://api.openai.com", bearerAuth("OPENAI_TOKEN"))],
  },
  similarweb: {
    apis: [
      api("https://api.similarweb.com", {
        headers: { "api-key": "${{ secrets.SIMILARWEB_API_KEY }}" },
      }),
    ],
  },
  perplexity: {
    apis: [api("https://api.perplexity.ai", bearerAuth("PERPLEXITY_TOKEN"))],
  },
  plausible: {
    apis: [api("https://plausible.io/api", bearerAuth("PLAUSIBLE_TOKEN"))],
  },
  mailchimp: {
    apis: Array.from({ length: 21 }, (_, i) =>
      api(
        `https://us${i + 1}.api.mailchimp.com/3.0`,
        bearerAuth("MAILCHIMP_TOKEN"),
      ),
    ),
  },
  chatwoot: {
    apis: [api("https://app.chatwoot.com", bearerAuth("CHATWOOT_TOKEN"))],
  },
  resend: {
    apis: [api("https://api.resend.com", bearerAuth("RESEND_TOKEN"))],
  },
  revenuecat: {
    apis: [api("https://api.revenuecat.com", bearerAuth("REVENUECAT_TOKEN"))],
  },
  pdf4me: {
    apis: [
      api("https://api.pdf4me.com", {
        headers: { Authorization: "${{ secrets.PDF4ME_TOKEN }}" },
      }),
    ],
  },
  pdfco: {
    apis: [
      api("https://api.pdf.co/v1", {
        headers: { "x-api-key": "${{ secrets.PDFCO_TOKEN }}" },
      }),
    ],
  },
  apify: {
    apis: [api("https://api.apify.com/v2", bearerAuth("APIFY_TOKEN"))],
  },
  "bright-data": {
    apis: [api("https://api.brightdata.com", bearerAuth("BRIGHTDATA_TOKEN"))],
  },
  browserbase: {
    apis: [
      api("https://api.browserbase.com/v1", {
        headers: { "X-BB-API-Key": "${{ secrets.BROWSERBASE_TOKEN }}" },
      }),
    ],
  },
  fireflies: {
    apis: [
      api("https://api.fireflies.ai/graphql", bearerAuth("FIREFLIES_TOKEN")),
    ],
  },
  explorium: {
    apis: [
      api("https://api.explorium.ai", {
        headers: { api_key: "${{ secrets.EXPLORIUM_TOKEN }}" },
      }),
    ],
  },
  firecrawl: {
    apis: [api("https://api.firecrawl.dev/v1", bearerAuth("FIRECRAWL_TOKEN"))],
  },
  scrapeninja: {
    apis: [
      api("https://scrapeninja.p.rapidapi.com", {
        headers: { "X-RapidAPI-Key": "${{ secrets.SCRAPENINJA_TOKEN }}" },
      }),
    ],
  },
  elevenlabs: {
    apis: [
      api("https://api.elevenlabs.io", {
        headers: { "xi-api-key": "${{ secrets.ELEVENLABS_TOKEN }}" },
      }),
    ],
  },
  devto: {
    apis: [
      api("https://dev.to/api", {
        headers: { "api-key": "${{ secrets.DEVTO_TOKEN }}" },
      }),
    ],
  },
  fal: {
    apis: [api("https://fal.run", bearerAuth("FAL_TOKEN"))],
  },
  podchaser: {
    apis: [api("https://api.podchaser.com", bearerAuth("PODCHASER_TOKEN"))],
  },
  pushinator: {
    apis: [api("https://api.pushinator.com", bearerAuth("PUSHINATOR_TOKEN"))],
  },
  qdrant: {
    apis: [
      api("https://cloud.qdrant.io", {
        headers: { "api-key": "${{ secrets.QDRANT_TOKEN }}" },
      }),
    ],
  },
  qiita: {
    apis: [api("https://qiita.com/api/v2", bearerAuth("QIITA_TOKEN"))],
  },
  reportei: {
    apis: [
      api("https://app.reportei.com/api/v1", bearerAuth("REPORTEI_TOKEN")),
    ],
  },
  zeptomail: {
    apis: [
      api("https://api.zeptomail.com/v1.1", {
        headers: {
          Authorization: "Zoho-enczapikey ${{ secrets.ZEPTOMAIL_TOKEN }}",
        },
      }),
    ],
  },
  runway: {
    apis: [api("https://api.dev.runwayml.com/v1", bearerAuth("RUNWAY_TOKEN"))],
  },
  shortio: {
    apis: [
      api("https://api.short.io", {
        headers: { Authorization: "${{ secrets.SHORTIO_TOKEN }}" },
      }),
    ],
  },
  supadata: {
    apis: [
      api("https://api.supadata.ai/v1", {
        headers: { "x-api-key": "${{ secrets.SUPADATA_TOKEN }}" },
      }),
    ],
  },
  tavily: {
    apis: [api("https://api.tavily.com", bearerAuth("TAVILY_TOKEN"))],
  },
  tldv: {
    apis: [
      api("https://pasta.tldv.io", {
        headers: { "x-api-key": "${{ secrets.TLDV_TOKEN }}" },
      }),
    ],
  },
  twenty: {
    apis: [api("https://api.twenty.com", bearerAuth("TWENTY_TOKEN"))],
  },
  wrike: {
    apis: [api("https://www.wrike.com/api/v4", bearerAuth("WRIKE_TOKEN"))],
  },
  zapier: {
    apis: [api("https://actions.zapier.com", bearerAuth("ZAPIER_TOKEN"))],
  },
  zapsign: {
    apis: [
      api("https://api.zapsign.com.br/api/v1", bearerAuth("ZAPSIGN_TOKEN")),
    ],
  },
};

/**
 * Expanded service config stored in compose content.
 * Resolved from service name + ServiceConfig at compose time, then frozen.
 *
 * - `name`: service config name (e.g., "slack")
 * - `ref`: key used in vm0.yaml to reference this service (= name in Phase 3)
 * - `description`: optional description from the service config
 */
export interface ExpandedServiceConfig {
  name: string;
  ref: string;
  description?: string;
  apis: ServiceApi[];
  placeholders?: Record<string, string>;
}

/**
 * Get service config for a connector type (base URLs + auth headers).
 * Returns undefined if the connector has no service config (e.g., computer connector).
 */
export function getServiceConfig(
  type: ConnectorType,
): ServiceConfig | undefined {
  const config = SERVICE_CONFIGS[type];
  if (!config) return undefined;
  return { ...config, name: type };
}
