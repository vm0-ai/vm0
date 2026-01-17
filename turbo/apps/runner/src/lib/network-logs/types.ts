/**
 * Network Logs Types
 *
 * Type definitions for network logging from mitmproxy addon.
 */

/**
 * Network log entry from mitmproxy addon
 *
 * Supports two modes:
 * - sni: SNI-only mode (no HTTPS decryption, only host/port/action)
 * - mitm: MITM mode (full HTTP details including method, status, latency, sizes)
 */
export interface NetworkLogEntry {
  timestamp: string;
  // Common fields (all modes)
  mode?: "mitm" | "sni";
  action?: "ALLOW" | "DENY";
  host?: string;
  port?: number;
  rule_matched?: string | null;
  // MITM-only fields (optional)
  method?: string;
  url?: string;
  status?: number;
  latency_ms?: number;
  request_size?: number;
  response_size?: number;
}
