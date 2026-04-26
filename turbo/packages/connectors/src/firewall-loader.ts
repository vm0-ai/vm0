/**
 * Firewall config loader.
 *
 * Checks builtin (generated) configs first, then falls back to fetching
 * firewall YAML files from GitHub repositories.
 */

import { parse as parseYaml } from "yaml";
import { resolveFirewallRef, parseGitHubTreeUrl } from "./github-url";
import { firewallConfigSchema, type FirewallConfig } from "./firewall-types";
import { getConnectorFirewall, isFirewallConnectorType } from "./firewalls";

/** Minimal fetch function signature for dependency injection in tests */
export type FetchFn = (url: string) => Promise<Response>;

/** Max response size for firewall YAML files (128KB) */
const MAX_RESPONSE_SIZE = 128 * 1024;

/**
 * Build the raw GitHub URL for a firewall's YAML config file.
 *
 * @param ref - Bare firewall name or full GitHub URL
 * @returns Raw GitHub URL pointing to firewall.yaml
 */
export function buildFirewallYamlUrl(ref: string): string {
  const url = resolveFirewallRef(ref);
  const parsed = parseGitHubTreeUrl(url);
  if (!parsed) {
    throw new Error(`Invalid firewall URL after resolution: ${url}`);
  }
  const pathPrefix = parsed.path ? `${parsed.path}/` : "";
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}/${pathPrefix}firewall.yaml`;
}

/**
 * Fetch and parse a firewall config.
 *
 * For builtin firewalls (e.g. "github"), returns the bundled config directly
 * without any network request. For custom firewalls, fetches from GitHub.
 *
 * @param ref - Bare firewall name (e.g. "github") or full GitHub URL
 * @param fetchFn - Optional fetch function (defaults to global fetch, injectable for tests)
 * @returns Validated FirewallConfig
 * @throws Error if fetch fails, YAML is invalid, or schema validation fails
 */
export async function fetchFirewallConfig(
  ref: string,
  fetchFn: FetchFn = fetch,
): Promise<FirewallConfig> {
  // Check builtin configs first (bare name only, not full URLs)
  const trimmed = ref.trim();
  const builtin =
    !trimmed.includes("/") && isFirewallConnectorType(trimmed)
      ? getConnectorFirewall(trimmed)
      : undefined;
  if (builtin) {
    return builtin;
  }

  const rawUrl = buildFirewallYamlUrl(ref);

  const res = await fetchFn(rawUrl);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch firewall config for "${ref}" from ${rawUrl}: ${res.status} ${res.statusText}`,
    );
  }

  const contentLength = res.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error(
      `Firewall config "${ref}" exceeds maximum size (${MAX_RESPONSE_SIZE} bytes)`,
    );
  }

  const content = await res.text();
  if (content.length > MAX_RESPONSE_SIZE) {
    throw new Error(
      `Firewall config "${ref}" exceeds maximum size (${MAX_RESPONSE_SIZE} bytes)`,
    );
  }

  let yamlData: unknown;
  try {
    yamlData = parseYaml(content);
  } catch (e) {
    throw new Error(
      `Invalid YAML in firewall config "${ref}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const result = firewallConfigSchema.safeParse(yamlData);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => {
        return `${i.path.join(".")}: ${i.message}`;
      })
      .join("; ");
    throw new Error(`Invalid firewall config "${ref}": ${issues}`);
  }

  return result.data;
}
