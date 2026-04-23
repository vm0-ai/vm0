import type { StorageManifest } from "../../../infra/storage/types";
import type { ResumeSession } from "../types";
import type { Firewalls, NetworkPolicies } from "@vm0/core/contracts/firewalls";

/**
 * Prepared execution context for executors
 *
 * This is the unified context that executors receive.
 * All preparation (storage manifest, working dir extraction, etc.) is done
 * before this context is created.
 */
export interface PreparedContext {
  // Identity
  runId: string;
  userId: string;
  sandboxToken: string;

  // What to run
  prompt: string;
  appendSystemPrompt: string | null;
  agentComposeVersionId: string;
  agentCompose: unknown;
  cliAgentType: string;
  workingDir: string;

  // Storage (prepared once, used by both executors)
  storageManifest: StorageManifest | null;

  // Environment & Secrets
  environment: Record<string, string> | null;
  secrets: Record<string, string> | null;
  secretConnectorMap: Record<string, string> | null;

  // Resume support
  resumeSession: ResumeSession | null;

  // Firewall for proxy-side token replacement (complete config, all permissions)
  firewalls: Firewalls | null;

  // Per-firewall network policies: which permissions are granted + unknownPolicy
  networkPolicies: NetworkPolicies | null;

  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: string[] | null;

  // Tools to make available in Claude CLI (passed as --tools)
  tools: string[] | null;

  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: string | null;

  // VM profile for resource allocation (e.g., "vm0/default")
  experimentalProfile: string | null;

  // Routing hint (runner group name)
  runnerGroup: string | null;

  // Metadata for vm0_start event
  resumedFromCheckpointId: string | null;
  continuedFromSessionId: string | null;

  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: boolean;

  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies: boolean;

  // API start time for E2E timing metrics
  apiStartTime: number;

  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  // Injected as TZ environment variable in sandbox if not already set in environment
  userTimezone: string | null;

  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: Record<string, boolean> | null;

  billableFirewalls: string[];
}

/**
 * Result of executor operations
 */
export interface ExecutorResult {
  runId: string;
  status: "running" | "pending";
  sandboxId?: string;
  createdAt: string;
  error?: string;
  sandboxType: "runner" | "docker";
}
