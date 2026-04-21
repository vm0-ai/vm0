/**
 * Connector firewalls that are platform-billable.
 *
 * Attaching one of these to a run adds its firewall name to the
 * billableFirewalls whitelist in the execution context, which surfaces as
 * flow.metadata["firewall_billable"] in mitm-addon. That flag gates
 * log_connector_usage (per-call billing) and the full-body response
 * buffering needed to extract the billing payload.
 */
export const BILLABLE_CONNECTORS = ["x"] as const;

export type BillableConnector = (typeof BILLABLE_CONNECTORS)[number];
