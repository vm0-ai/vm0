import {
  networkLogActionSchema,
  type NetworkLogEntry,
} from "@vm0/api-contracts/contracts/runs";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => {
    return typeof item === "string";
  });
  return strings.length === value.length ? strings : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    },
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function networkActionValue(
  value: unknown,
): NetworkLogEntry["action"] | undefined {
  const parsed = networkLogActionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function networkBodyEncodingValue(
  value: unknown,
): NetworkLogEntry["request_body_encoding"] | undefined {
  if (value !== "base64" && value !== "binary") {
    if (
      typeof value !== "string" ||
      value.length !== 5 ||
      value.slice(0, 3) !== "utf" ||
      value[3] !== "-" ||
      value[4] !== "8"
    ) {
      return undefined;
    }
  }
  return value as NetworkLogEntry["request_body_encoding"];
}

function omitUndefined<T extends UnknownRecord>(record: T): UnknownRecord {
  return Object.fromEntries(
    Object.entries(record).filter((entry) => {
      return entry[1] !== undefined;
    }),
  );
}

function sanitizeAxiomNetworkEvent(event: unknown): NetworkLogEntry | null {
  if (!isRecord(event)) {
    return null;
  }

  const timestamp = stringValue(event._time);
  if (!timestamp) {
    return null;
  }

  return omitUndefined({
    timestamp,
    type: stringValue(event.type),
    action: networkActionValue(event.action),
    host: stringValue(event.host),
    port: numberValue(event.port),
    method: stringValue(event.method),
    url: stringValue(event.url),
    status: numberValue(event.status),
    latency_ms: numberValue(event.latency_ms),
    request_size: numberValue(event.request_size),
    response_size: numberValue(event.response_size),
    browser_user_agent: booleanValue(event.browser_user_agent),
    dns_event: stringValue(event.dns_event),
    dns_query_type: stringValue(event.dns_query_type),
    dns_result: stringValue(event.dns_result),
    dns_serial: stringValue(event.dns_serial),
    firewall_base: stringValue(event.firewall_base),
    firewall_name: stringValue(event.firewall_name),
    firewall_permission: stringValue(event.firewall_permission),
    firewall_rule_match: stringValue(event.firewall_rule_match),
    firewall_params: stringRecordValue(event.firewall_params),
    firewall_billable: booleanValue(event.firewall_billable),
    firewall_error: stringValue(event.firewall_error),
    connector_diagnostic_type: stringValue(event.connector_diagnostic_type),
    connector_diagnostic_reason: stringValue(event.connector_diagnostic_reason),
    connector_diagnostic_env_names: stringArrayValue(
      event.connector_diagnostic_env_names,
    ),
    connector_diagnostic_base: stringValue(event.connector_diagnostic_base),
    auth_resolved_secrets: stringArrayValue(event.auth_resolved_secrets),
    auth_refreshed_connectors: stringArrayValue(
      event.auth_refreshed_connectors,
    ),
    auth_refreshed_secrets: stringArrayValue(event.auth_refreshed_secrets),
    auth_cache_hit: booleanValue(event.auth_cache_hit),
    auth_url_rewrite: booleanValue(event.auth_url_rewrite),
    error: stringValue(event.error),
    request_headers: stringRecordValue(event.request_headers),
    request_body: stringValue(event.request_body),
    request_body_encoding: networkBodyEncodingValue(
      event.request_body_encoding,
    ),
    request_body_truncated: booleanValue(event.request_body_truncated),
    response_headers: stringRecordValue(event.response_headers),
    response_body: stringValue(event.response_body),
    response_body_encoding: networkBodyEncodingValue(
      event.response_body_encoding,
    ),
    response_body_truncated: booleanValue(event.response_body_truncated),
  }) as NetworkLogEntry;
}

export function sanitizeAxiomNetworkEvents(
  events: readonly unknown[],
): NetworkLogEntry[] {
  return events.flatMap((event) => {
    const networkLog = sanitizeAxiomNetworkEvent(event);
    return networkLog ? [networkLog] : [];
  });
}
