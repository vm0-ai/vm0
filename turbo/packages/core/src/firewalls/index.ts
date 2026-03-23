/**
 * Builtin firewall configs registry.
 *
 * Generated configs are imported here and exposed as a lookup map.
 * The firewall loader checks this registry before falling back to
 * remote GitHub fetch.
 */

import type { FirewallConfig } from "../contracts/firewalls";
import { githubFirewall } from "./github.generated";

export const builtinFirewalls: Record<string, FirewallConfig> = {
  github: githubFirewall,
};
