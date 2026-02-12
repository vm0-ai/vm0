import type { StorageManifest } from "../../storage/types";
import type { ResumeSession } from "../types";
import type { ArtifactSnapshot } from "../../checkpoint/types";
import type { ExperimentalFirewall } from "@vm0/core";

/**
 * Prepared execution context for executors
 *
 * This is the unified context that both E2B and Runner executors receive.
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
  agentComposeVersionId: string;
  agentCompose: unknown;
  cliAgentType: string;
  workingDir: string;

  // Storage (prepared once, used by both executors)
  storageManifest: StorageManifest | null;

  // Environment & Secrets
  environment: Record<string, string> | null;
  secrets: Record<string, string> | null;
  secretNames: string[] | null;

  // Resume support
  resumeSession: ResumeSession | null;
  resumeArtifact: ArtifactSnapshot | null;

  // Artifact settings
  artifactName: string | null;
  artifactVersion: string | null;

  // Experimental firewall configuration
  experimentalFirewall: ExperimentalFirewall | null;

  // Routing hint (null = E2B, string = runner group)
  runnerGroup: string | null;

  // Metadata for vm0_start event
  agentName: string | null;
  resumedFromCheckpointId: string | null;
  continuedFromSessionId: string | null;

  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: boolean;

  // API start time for E2E timing metrics
  apiStartTime: number | null;

  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  // Injected as TZ environment variable in sandbox if not already set in environment
  userTimezone: string | null;
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
}
