import chalk from "chalk";
import * as fs from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { getEvents } from "../../lib/api";
import { parseEvent } from "../../lib/events/event-parser-factory";
import { EventRenderer } from "../../lib/events/event-renderer";
import {
  extractAndGroupVariables,
  firewallPoliciesSchema,
  type FirewallPolicies,
} from "@vm0/core";
/**
 * Collector for --secrets and --vars flags
 * Format: KEY=value
 */
export function collectKeyValue(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const [key, ...valueParts] = value.split("=");
  const val = valueParts.join("="); // Support values with '='

  if (!key || val === undefined || val === "") {
    throw new Error(`Invalid format: ${value} (expected KEY=value)`);
  }

  return { ...previous, [key]: val };
}

/**
 * Collector for --volume-version flags
 * Format: volumeName=version
 */
export function collectVolumeVersions(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const [volumeName, ...versionParts] = value.split("=");
  const version = versionParts.join("=");

  if (!volumeName || version === undefined || version === "") {
    throw new Error(
      `Invalid volume-version format: ${value} (expected volumeName=version)`,
    );
  }

  return { ...previous, [volumeName]: version };
}

/**
 * Parse Docker-style volume declaration.
 * Format: "name:/mount/path" (latest) or "name:version:/mount/path" (specific version)
 *
 * Parsing rule: split on ':', last segment starts with '/' = mount path,
 * first = storage name, middle (if present) = version.
 */
export function parseVolume(value: string): {
  name: string;
  version?: string;
  mountPath: string;
} {
  const parts = value.split(":");

  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid volume format: ${value} (expected name:/path or name:version:/path)`,
    );
  }

  // After the length check above, parts has exactly 2 or 3 elements
  const name = parts[0] as string;
  const mountPath =
    parts.length === 3 ? (parts[2] as string) : (parts[1] as string);

  if (!name) {
    throw new Error(`Invalid volume format: ${value} (name cannot be empty)`);
  }

  if (!mountPath.startsWith("/")) {
    throw new Error(
      `Invalid volume mount path: ${mountPath} (must start with /)`,
    );
  }

  if (parts.length === 2) {
    return { name, mountPath };
  }

  const version = parts[1] as string;
  if (!version) {
    throw new Error(
      `Invalid volume format: ${value} (version cannot be empty)`,
    );
  }

  return { name, version, mountPath };
}

/**
 * Collector for repeatable --volume flags.
 * Accumulates into an array of parsed volume objects.
 */
export function collectVolumes(
  value: string,
  previous: Array<{ name: string; version?: string; mountPath: string }>,
): Array<{ name: string; version?: string; mountPath: string }> {
  return [...previous, parseVolume(value)];
}

/**
 * Parse and validate --permission-policies JSON string.
 * Returns undefined when no value is provided.
 */
export function parsePermissionPolicies(
  json: string | undefined,
): FirewallPolicies | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `Invalid --permission-policies JSON: ${json}\nExpected format: '{"ref": {"permissions": {"perm": "allow|deny|ask"}}}'`,
    );
  }
  const result = firewallPoliciesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid --permission-policies: ${result.error.issues
        .map((i) => {
          return i.message;
        })
        .join(", ")}`,
    );
  }
  return result.data;
}

export function isUUID(str: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(str);
}

/**
 * Extract var names from compose config
 */
export function extractVarNames(composeContent: unknown): string[] {
  const grouped = extractAndGroupVariables(composeContent);
  return grouped.vars.map((r) => {
    return r.name;
  });
}

/**
 * Extract secret names from compose config
 */
export function extractSecretNames(composeContent: unknown): string[] {
  const grouped = extractAndGroupVariables(composeContent);
  return grouped.secrets.map((r) => {
    return r.name;
  });
}

/**
 * Load values with priority: CLI args > --env-file > environment variables
 *
 * For values referenced in the compose config but not provided via CLI,
 * falls back to --env-file (if specified) and environment variables.
 * CLI-provided values are always passed through.
 *
 * Priority order (matches Docker CLI):
 * 1. CLI flags (--vars, --secrets) - HIGHEST
 * 2. --env-file values - MEDIUM
 * 3. process.env - LOWEST
 *
 * @param cliValues Values passed via CLI flags
 * @param configNames Names referenced in compose config (for env fallback)
 * @param envFilePath Optional path to env file (only loads if explicitly provided)
 * @returns Merged values object with CLI taking highest priority
 */
export function loadValues(
  cliValues: Record<string, string>,
  configNames: string[],
  envFilePath?: string,
): Record<string, string> | undefined {
  // Start with CLI-provided values (highest priority, always passed through)
  const result: Record<string, string> = { ...cliValues };

  // For names referenced in config but not provided via CLI, load from file/env
  const missingNames = configNames.filter((name) => {
    return !(name in result);
  });

  if (missingNames.length > 0) {
    // Get from environment variables (lowest priority)
    const envValues: Record<string, string> = {};
    for (const name of missingNames) {
      const envValue = process.env[name];
      if (envValue !== undefined) {
        envValues[name] = envValue;
      }
    }

    // Load from --env-file if explicitly provided (medium priority, overrides env)
    let fileValues: Record<string, string> = {};
    if (envFilePath) {
      if (!fs.existsSync(envFilePath)) {
        throw new Error(`Environment file not found: ${envFilePath}`);
      }
      const dotenvResult = dotenvConfig({ path: envFilePath, quiet: true });
      if (dotenvResult.parsed) {
        // Only include keys that are missing from CLI
        fileValues = Object.fromEntries(
          Object.entries(dotenvResult.parsed).filter(([key]) => {
            return missingNames.includes(key);
          }),
        );
      }
    }

    // Merge with priority: file > env (CLI already in result)
    // Apply env first, then file values override
    Object.assign(result, envValues, fileValues);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse identifier with optional org and version specifier
 * Format: name[:version]
 * Examples:
 *   "demo:d084948d"      → { name: "demo", version: "d084948d" }
 *   "demo:latest"        → { name: "demo", version: "latest" }
 *   "demo"               → { name: "demo" }
 */
export function parseIdentifier(identifier: string): {
  name: string;
  version?: string;
} {
  // UUIDs don't contain colons or slashes, so check first
  if (isUUID(identifier)) {
    return { name: identifier };
  }

  // Parse name:version format using indexOf (version comes after name)
  const colonIndex = identifier.indexOf(":");
  if (colonIndex > 0 && colonIndex < identifier.length - 1) {
    return {
      name: identifier.slice(0, colonIndex),
      version: identifier.slice(colonIndex + 1),
    };
  }

  return { name: identifier };
}

/**
 * Parse artifact identifier: "name" or "name:version"
 * Returns undefined when no value is provided.
 * Examples:
 *   "my-artifact"          → { artifactName: "my-artifact" }
 *   "my-artifact:abc123"   → { artifactName: "my-artifact", artifactVersion: "abc123" }
 */
export function parseArtifact(value: string | undefined):
  | {
      artifactName: string;
      artifactVersion?: string;
    }
  | undefined {
  if (!value) return undefined;
  const colonIndex = value.indexOf(":");
  if (colonIndex > 0 && colonIndex < value.length - 1) {
    return {
      artifactName: value.slice(0, colonIndex),
      artifactVersion: value.slice(colonIndex + 1),
    };
  }
  return { artifactName: value };
}

/**
 * Display run created info (queued or started)
 */
export function renderRunCreated(response: {
  status: string;
  runId: string;
  sandboxId?: string;
}): void {
  if (response.status === "queued") {
    console.log(chalk.yellow("⚠ Run queued — concurrency limit reached"));
    console.log(`  Run ID:  ${chalk.dim(response.runId)}`);
    console.log(
      chalk.dim("  Will start automatically when a slot is available"),
    );
    console.log();
  } else {
    EventRenderer.renderRunStarted({
      runId: response.runId,
      sandboxId: response.sandboxId,
    });
  }
}

export interface PollResult {
  succeeded: boolean;
  runId: string;
  sessionId?: string;
  checkpointId?: string;
}

/**
 * Options for polling/streaming events
 */
export interface EventRenderingOptions {
  verbose?: boolean;
}

/**
 * Poll for events until run completes (via run.status field)
 * @returns Poll result with success status and optional session/checkpoint IDs
 */
export async function pollEvents(
  runId: string,
  options?: EventRenderingOptions,
): Promise<PollResult> {
  const renderer = new EventRenderer({ verbose: options?.verbose });

  let nextSequence = -1;
  let complete = false;
  let result: PollResult = { succeeded: true, runId };
  const pollIntervalMs = 1000;

  while (!complete) {
    const response = await getEvents(runId, {
      since: nextSequence,
    });

    // Render agent events (use appropriate renderer based on framework from API)
    for (const event of response.events) {
      const eventData = event.eventData as Record<string, unknown>;

      const parsed = parseEvent(eventData);
      if (parsed) {
        renderer.render(parsed);
      }
    }

    nextSequence = response.nextSequence;

    // Check run status for completion (replaces vm0_result/vm0_error events)
    const runStatus = response.run.status;

    if (runStatus === "completed") {
      complete = true;
      // Render completion info
      EventRenderer.renderRunCompleted(response.run.result);
      result = {
        succeeded: true,
        runId,
        sessionId: response.run.result?.agentSessionId,
        checkpointId: response.run.result?.checkpointId,
      };
    } else if (runStatus === "failed") {
      complete = true;
      // Render error info
      EventRenderer.renderRunFailed(response.run.error, runId);
      result = { succeeded: false, runId };
    } else if (runStatus === "timeout") {
      complete = true;
      console.error(chalk.red("\n✗ Run timed out"));
      console.error(
        chalk.dim(`  (use "vm0 logs ${runId} --system" to view system logs)`),
      );
      result = { succeeded: false, runId };
    } else if (runStatus === "cancelled") {
      complete = true;
      console.error(chalk.yellow("\n✗ Run cancelled"));
      result = { succeeded: false, runId };
    }

    // If not complete, wait before next poll
    if (!complete) {
      await new Promise((resolve) => {
        return setTimeout(resolve, pollIntervalMs);
      });
    }
  }

  return result;
}

/**
 * Display next steps after successful run
 */
export function showNextSteps(result: PollResult): void {
  const { runId, sessionId, checkpointId } = result;

  console.log();

  // Always show logs command since we always have runId
  console.log("  View agent logs:");
  console.log(chalk.cyan(`    vm0 logs ${runId}`));

  if (sessionId) {
    console.log("  Continue with session (latest conversation and artifact):");
    console.log(
      chalk.cyan(`    vm0 run continue ${sessionId} "your next prompt"`),
    );
  }
  if (checkpointId) {
    console.log(
      "  Resume from checkpoint (snapshotted conversation and artifact):",
    );
    console.log(
      chalk.cyan(`    vm0 run resume ${checkpointId} "your next prompt"`),
    );
  }
}
