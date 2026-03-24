import { z } from "zod";
import type { ConnectorType } from "./connectors";

/**
 * Proxy-side firewall configuration for token replacement.
 *
 * All firewall zod schemas are defined here as the single source of truth.
 * Other modules (composes.ts, runners.ts) import from here.
 *
 * Firewall configs are hosted in GitHub: vm0-ai/vm0-firewalls
 * See expandFirewallConfigs() in firewall-expander.ts for resolution logic.
 */

/**
 * Firewall permission schema — a named permission group with matching rules.
 * Rules use the format `METHOD /path` where path is relative to the API entry's base URL.
 */
export const firewallPermissionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  rules: z.array(z.string()),
});

/**
 * Firewall API entry — a base URL with auth headers and optional permissions.
 */
export const firewallApiSchema = z.object({
  base: z.string(),
  auth: z.object({
    headers: z.record(z.string(), z.string()),
  }),
  permissions: z.array(firewallPermissionSchema).optional(),
});

/**
 * A single firewall with its name, ref, and API entries.
 * Used in the expanded (post-compose) format.
 */
export const firewallSchema = z.object({
  name: z.string(),
  ref: z.string(),
  apis: z.array(firewallApiSchema),
});

/**
 * Experimental firewall configuration for proxy-side token replacement.
 * Flat array of firewall entries: [{ name, ref, apis }]
 */
export const experimentalFirewallsSchema = z.array(firewallSchema);

/**
 * Zod schema for validating firewall config (GitHub-hosted YAML).
 */
export const firewallConfigSchema = z.object({
  name: z.string().min(1, "Firewall name is required"),
  description: z.string().optional(),
  apis: z
    .array(firewallApiSchema)
    .min(1, "Firewall must have at least one API entry"),
  placeholders: z.record(z.string(), z.string()).optional(),
});

/**
 * Firewall policy value — per-permission access control.
 * - "allow": always allow without prompting
 * - "deny": always deny
 * - "ask": prompt user for approval each time
 */
export const firewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);
export type FirewallPolicyValue = z.infer<typeof firewallPolicyValueSchema>;

/**
 * Firewall policies — nested map of firewall ref → permission name → policy.
 * Example: { "github": { "repo-read": "allow", "issues-write": "deny" } }
 */
export const firewallPoliciesSchema = z.record(
  z.string(),
  z.record(z.string(), firewallPolicyValueSchema),
);
export type FirewallPolicies = z.infer<typeof firewallPoliciesSchema>;

/** Inferred types */
export type FirewallApi = z.infer<typeof firewallApiSchema>;
export type FirewallConfig = z.infer<typeof firewallConfigSchema>;
export type Firewall = z.infer<typeof firewallSchema>;
export type ExperimentalFirewalls = z.infer<typeof experimentalFirewallsSchema>;

/**
 * Maps connector types (skill short names) to their builtin firewall ref(s).
 * Only includes connectors that have builtin firewall configs.
 */
const CONNECTOR_FIREWALL_REFS: Readonly<
  Partial<Record<ConnectorType, readonly string[]>>
> = {
  agentmail: ["agentmail"],
  ahrefs: ["ahrefs"],
  airtable: ["airtable"],
  apify: ["apify"],
  asana: ["asana"],
  axiom: ["axiom"],
  "brave-search": ["brave-search"],
  brevo: ["brevo"],
  "bright-data": ["bright-data"],
  browserbase: ["browserbase"],
  clickup: ["clickup"],
  close: ["close"],
  cloudflare: ["cloudflare"],
  deepseek: ["deepseek"],
  devto: ["devto"],
  discord: ["discord"],
  github: ["github"],
  gitlab: ["gitlab"],
  slack: ["slack"],
  gmail: ["gmail"],
  "google-sheets": ["google-sheets"],
  "google-docs": ["google-docs"],
  "google-drive": ["google-drive"],
  "google-calendar": ["google-calendar"],
  elevenlabs: ["elevenlabs"],
  fal: ["fal"],
  fireflies: ["fireflies"],
  heygen: ["heygen"],
  hubspot: ["hubspot"],
  "hugging-face": ["hugging-face"],
  intercom: ["intercom"],
  atlassian: ["jira", "confluence"],
  linear: ["linear"],
  loops: ["loops"],
  monday: ["monday"],
  neon: ["neon"],
  figma: ["figma"],
  firecrawl: ["firecrawl"],
  notion: ["notion"],
  openai: ["openai"],
  perplexity: ["perplexity"],
  plausible: ["plausible"],
  posthog: ["posthog"],
  resend: ["resend"],
  runway: ["runway"],
  sentry: ["sentry"],
  serpapi: ["serpapi"],
  shortio: ["shortio"],
  stripe: ["stripe"],
  supabase: ["supabase"],
  tavily: ["tavily"],
  todoist: ["todoist"],
  vercel: ["vercel"],
  x: ["x"],
  youtube: ["youtube"],
  zapier: ["zapier"],
  zapsign: ["zapsign"],
  zeptomail: ["zeptomail"],
};

/** Get the firewall ref names for a connector type. Returns empty array if none. */
export function getFirewallRefsForConnector(
  connector: ConnectorType,
): string[] {
  return [...(CONNECTOR_FIREWALL_REFS[connector] ?? [])];
}

/**
 * Regex pattern matching `${{ secrets.XXX }}` references in auth header templates.
 * Tolerates optional whitespace inside braces: `${{ secrets.X }}` and `${{secrets.X}}`.
 */
const AUTH_SECRET_PATTERN =
  /\$\{\{\s*secrets\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Extract all secret names referenced in firewall rule auth header templates.
 * E.g., `Bearer ${{ secrets.GITHUB_TOKEN }}` → `["GITHUB_TOKEN"]`
 */
export function extractSecretNamesFromApis(
  apis: FirewallConfig["apis"],
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

/**
 * Expanded firewall config stored in compose content.
 * Resolved from firewall name + FirewallConfig at compose time, then frozen.
 *
 * - `name`: firewall config name (e.g., "slack")
 * - `ref`: key used in vm0.yaml to reference this firewall config
 * - `description`: optional description from the firewall config
 */
export interface ExpandedFirewallConfig {
  name: string;
  ref: string;
  description?: string;
  apis: FirewallApi[];
  placeholders?: Record<string, string>;
}
