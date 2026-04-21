import type { FirewallConnectorType } from "./index";

/**
 * Connector firewalls that are platform-billable.
 *
 * Attaching one of these to a run adds its firewall name to the
 * billableFirewalls whitelist in the execution context, which surfaces as
 * flow.metadata["firewall_billable"] in mitm-addon. That flag gates
 * log_connector_usage (per-call billing) and the full-body response
 * buffering needed to extract the billing payload.
 *
 * The `satisfies ReadonlyArray<FirewallConnectorType>` constraint catches
 * typos at compile time: any literal here must be a valid firewall
 * connector type (key of `CONNECTOR_FIREWALLS`). The `import type` is
 * erased at compile time, so the re-export cycle through `./index` is
 * safe at runtime.
 */
export const BILLABLE_CONNECTORS = [
  "x",
] as const satisfies ReadonlyArray<FirewallConnectorType>;

export type BillableConnector = (typeof BILLABLE_CONNECTORS)[number];
