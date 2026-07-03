import type { ConnectorType } from "./connectors";
import { getConnectorEnvBindingEntries } from "./connector-utils";
import type { FirewallConfig } from "./firewall-types";

/**
 * Expand firewall placeholders to cover all secret names related to the
 * connector. For each existing placeholder key, find related names via
 * configured env binding entries (raw storage names and sibling aliases)
 * and assign the same placeholder value.
 */
export function expandFirewallPlaceholders(
  firewall: FirewallConfig,
  connectorType: ConnectorType,
): FirewallConfig {
  if (!firewall.placeholders) return firewall;

  const envBindingEntries = getConnectorEnvBindingEntries(connectorType);
  if (envBindingEntries.length === 0) return firewall;

  const expanded: Record<string, string> = { ...firewall.placeholders };

  for (const [key, placeholderValue] of Object.entries(firewall.placeholders)) {
    const valueRefs = envBindingEntries
      .filter(({ envName }) => {
        return envName === key;
      })
      .map(({ valueRef }) => {
        return valueRef;
      });
    for (const valueRef of valueRefs) {
      if (!valueRef.startsWith("$secrets.")) {
        continue;
      }
      const rawName = valueRef.slice("$secrets.".length);
      if (!expanded[rawName]) {
        expanded[rawName] = placeholderValue;
      }
      for (const entry of envBindingEntries) {
        if (entry.valueRef === valueRef && !expanded[entry.envName]) {
          expanded[entry.envName] = placeholderValue;
        }
      }
    }

    const rawRef = `$secrets.${key}`;
    for (const entry of envBindingEntries) {
      if (entry.valueRef === rawRef && !expanded[entry.envName]) {
        expanded[entry.envName] = placeholderValue;
      }
    }
  }

  return { ...firewall, placeholders: expanded };
}
