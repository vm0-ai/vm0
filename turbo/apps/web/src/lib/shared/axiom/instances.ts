/**
 * Shared Axiom client instances.
 *
 * This is a leaf module with no dependency on logger.ts, breaking the
 * circular dependency chain: axiom/client → logger → axiom/client.
 *
 * Both axiom/client.ts and logger.ts import from here to share the same
 * Axiom SDK instances, ensuring a single flush covers all datasets.
 */
import { Axiom } from "@axiomhq/js";

let sessionsClient: Axiom | null = null;
let telemetryClient: Axiom | null = null;
let sessionsInitialized = false;
let telemetryInitialized = false;

/**
 * Get or create the sessions-scoped Axiom client (agent-run-events).
 */
export function getSessionsInstance(token: string | undefined): Axiom | null {
  if (sessionsInitialized) {
    // Late initialization: first caller had no token, but one is now available.
    if (token && !sessionsClient) {
      sessionsClient = new Axiom({ token });
    }
    return sessionsClient;
  }
  sessionsInitialized = true;
  if (!token) return null;
  sessionsClient = new Axiom({ token });
  return sessionsClient;
}

/**
 * Get or create the telemetry-scoped Axiom client (all other datasets).
 */
export function getTelemetryInstance(token: string | undefined): Axiom | null {
  if (telemetryInitialized) {
    if (token && !telemetryClient) {
      telemetryClient = new Axiom({ token });
    }
    return telemetryClient;
  }
  telemetryInitialized = true;
  if (!token) return null;
  telemetryClient = new Axiom({ token });
  return telemetryClient;
}

/** Access the sessions client after initialization. */
export function getSessionsClient(): Axiom | null {
  return sessionsClient;
}

/** Access the telemetry client after initialization. */
export function getTelemetryClient(): Axiom | null {
  return telemetryClient;
}
