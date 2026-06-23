import {
  type FirewallSelection,
  resolveFirewallConfigSelection,
} from "./firewall-expander";
import {
  isRuntimeFirewallConnectorType,
  loadConnectorFirewall,
  type RuntimeFirewallConnectorType,
} from "./firewall-runtime";
import type { ExpandedFirewallConfig } from "./firewall-types";

function resolveRuntimeFirewallType(
  name: string,
): RuntimeFirewallConnectorType {
  const trimmed = name.trim();
  if (trimmed.includes("/") || !isRuntimeFirewallConnectorType(trimmed)) {
    throw new Error(
      `Unsupported firewall "${name}": only built-in connector firewalls are supported`,
    );
  }
  return trimmed;
}

export async function resolveFirewallSelections(
  selections: Record<string, FirewallSelection>,
): Promise<ExpandedFirewallConfig[]> {
  const entries = Object.entries(selections);
  if (entries.length === 0) return [];

  const runtimeTypes = entries.map(([name]) => {
    return resolveRuntimeFirewallType(name);
  });
  const configs = await Promise.all(
    runtimeTypes.map((type) => {
      return loadConnectorFirewall(type);
    }),
  );

  const expanded: ExpandedFirewallConfig[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [, selection] = entries[i]!;
    const config = configs[i]!;
    const resolved = resolveFirewallConfigSelection(config, selection);
    if (resolved !== null) {
      expanded.push(resolved);
    }
  }

  return expanded;
}
