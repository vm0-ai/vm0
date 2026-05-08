import chalk from "chalk";
import * as fs from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { getEvents } from "../../lib/api";
import type { GetEventsResponse } from "../../lib/api/core/types";
import { parseEvent } from "../../lib/events/event-parser-factory";
import { EventRenderer } from "../../lib/events/event-renderer";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import {
  firewallPoliciesSchema,
  type FirewallPolicies,
} from "@vm0/connectors/firewall-types";
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
 * Parse Docker-style mount declaration shared by --volume and --artifact.
 * Format: "name:/mount/path" (latest) or "name:version:/mount/path" (specific version)
 *
 * Parsing rule: split on ':', last segment starts with '/' = mount path,
 * first = storage name, middle (if present) = version.
 */
export function parseMount(
  value: string,
  flagLabel: "volume" | "artifact",
): {
  name: string;
  version?: string;
  mountPath: string;
} {
  const parts = value.split(":");

  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid ${flagLabel} format: ${value} (expected name:/path or name:version:/path)`,
    );
  }

  // After the length check above, parts has exactly 2 or 3 elements
  const name = parts[0] as string;
  const mountPath =
    parts.length === 3 ? (parts[2] as string) : (parts[1] as string);

  if (!name) {
    throw new Error(
      `Invalid ${flagLabel} format: ${value} (name cannot be empty)`,
    );
  }

  if (!mountPath.startsWith("/")) {
    throw new Error(
      `Invalid ${flagLabel} mount path: ${mountPath} (must start with /)`,
    );
  }

  if (parts.length === 2) {
    return { name, mountPath };
  }

  const version = parts[1] as string;
  if (!version) {
    throw new Error(
      `Invalid ${flagLabel} format: ${value} (version cannot be empty)`,
    );
  }

  return { name, version, mountPath };
}

/**
 * Collector for repeatable --volume flags.
 * Accumulates into an array of parsed mount objects.
 */
export function collectMounts(
  value: string,
  previous: Array<{ name: string; version?: string; mountPath: string }>,
): Array<{ name: string; version?: string; mountPath: string }> {
  return [...previous, parseMount(value, "volume")];
}

/**
 * Collector for repeatable --artifact flags.
 * Accumulates into an array of parsed mount objects.
 */
export function collectArtifacts(
  value: string,
  previous: Array<{ name: string; version?: string; mountPath: string }>,
): Array<{ name: string; version?: string; mountPath: string }> {
  return [...previous, parseMount(value, "artifact")];
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

type RunState = GetEventsResponse["run"];
type TerminalRunStatus = "completed" | "failed" | "timeout" | "cancelled";
type TerminalRunState = RunState & { status: TerminalRunStatus };
interface TerminalDrainState {
  runState?: TerminalRunState;
  seenAt: number;
  lastProgressAt: number;
}

const TERMINAL_RUN_STATUSES: readonly TerminalRunStatus[] = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
];
const POLL_INTERVAL_MS = 1000;
const TERMINAL_DRAIN_POLL_INTERVAL_MS = 500;
const TERMINAL_DRAIN_IDLE_MS = 1000;
const TERMINAL_DRAIN_MAX_MS = 3000;

/**
 * Options for polling/streaming events
 */
export interface EventRenderingOptions {
  verbose?: boolean;
}

function isTerminalRunState(run: RunState): run is TerminalRunState {
  return TERMINAL_RUN_STATUSES.includes(run.status as TerminalRunStatus);
}

function shouldDrainNextEventPage(
  response: GetEventsResponse,
  madeSequenceProgress: boolean,
): boolean {
  return response.hasMore && response.events.length > 0 && madeSequenceProgress;
}

function isBlockedBySequenceGap(
  response: GetEventsResponse,
  madeSequenceProgress: boolean,
): boolean {
  return response.hasMore && !madeSequenceProgress;
}

function hasTerminalWatermark(run: TerminalRunState): boolean {
  return run.lastEventSequence !== undefined;
}

function hasReachedTerminalWatermark(
  run: TerminalRunState,
  nextSequence: number,
): boolean {
  return (
    run.lastEventSequence !== undefined && nextSequence >= run.lastEventSequence
  );
}

function shouldCompleteTerminalDrain(
  terminalSeenAt: number,
  lastTerminalProgressAt: number,
  blockedByGap: boolean,
): boolean {
  const now = Date.now();
  const terminalElapsedMs = now - terminalSeenAt;
  const terminalIdleMs = now - lastTerminalProgressAt;
  return (
    terminalElapsedMs >= TERMINAL_DRAIN_MAX_MS ||
    (!blockedByGap && terminalIdleMs >= TERMINAL_DRAIN_IDLE_MS)
  );
}

function updateTerminalDrainState(
  state: TerminalDrainState,
  run: RunState,
  madeSequenceProgress: boolean,
  now: number,
): void {
  if (isTerminalRunState(run)) {
    if (!state.runState) {
      state.seenAt = now;
      state.lastProgressAt = now;
    } else if (madeSequenceProgress) {
      state.lastProgressAt = now;
    }
    state.runState = run;
    return;
  }

  if (state.runState && madeSequenceProgress) {
    state.lastProgressAt = now;
  }
}

function isBlockedByTerminalWatermark(
  run: TerminalRunState,
  nextSequence: number,
): boolean {
  return (
    hasTerminalWatermark(run) && !hasReachedTerminalWatermark(run, nextSequence)
  );
}

function shouldReturnTerminalRunResult(
  state: TerminalDrainState,
  response: GetEventsResponse,
  nextSequence: number,
  madeSequenceProgress: boolean,
  seenResultEvent: boolean,
): boolean {
  const run = state.runState;
  if (!run) {
    return false;
  }

  if (!hasTerminalWatermark(run) && run.status !== "completed") {
    if (
      run.status === "timeout" &&
      shouldDrainNextEventPage(response, madeSequenceProgress)
    ) {
      return false;
    }
    return true;
  }

  if (!hasTerminalWatermark(run) && seenResultEvent) {
    return true;
  }

  return shouldCompleteTerminalDrain(
    state.seenAt,
    state.lastProgressAt,
    isBlockedBySequenceGap(response, madeSequenceProgress) ||
      isBlockedByTerminalWatermark(run, nextSequence),
  );
}

function renderTerminalRunResult(
  runId: string,
  run: TerminalRunState,
): PollResult {
  if (run.status === "completed") {
    EventRenderer.renderRunCompleted(run.result);
    return {
      succeeded: true,
      runId,
      sessionId: run.result?.agentSessionId,
      checkpointId: run.result?.checkpointId,
    };
  }

  if (run.status === "failed") {
    EventRenderer.renderRunFailed(run.error, runId);
    return { succeeded: false, runId };
  }

  if (run.status === "timeout") {
    console.error(chalk.red("\n✗ Run timed out"));
    console.error(
      chalk.dim(`  (use "vm0 logs ${runId} --system" to view system logs)`),
    );
    return { succeeded: false, runId };
  }

  console.error(chalk.yellow("\n✗ Run cancelled"));
  return { succeeded: false, runId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
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
  const terminalDrain: TerminalDrainState = {
    seenAt: 0,
    lastProgressAt: 0,
  };
  let seenResultEvent = false;

  for (;;) {
    const previousSequence = nextSequence;
    const response = await getEvents(runId, {
      since: nextSequence,
    });
    const now = Date.now();
    const madeSequenceProgress = response.nextSequence > previousSequence;
    let pageHasResultEvent = false;

    // Render agent events (use appropriate renderer based on framework from API)
    if (madeSequenceProgress) {
      for (const event of response.events) {
        const eventData = event.eventData as Record<string, unknown>;

        const parsed = parseEvent(eventData, response.framework);
        if (parsed) {
          renderer.render(parsed);
          if (parsed.type === "result") {
            pageHasResultEvent = true;
          }
        }
      }
    }

    if (madeSequenceProgress) {
      if (pageHasResultEvent) {
        seenResultEvent = true;
      }

      nextSequence = response.nextSequence;
    }

    updateTerminalDrainState(
      terminalDrain,
      response.run,
      madeSequenceProgress,
      now,
    );

    if (
      terminalDrain.runState &&
      hasReachedTerminalWatermark(terminalDrain.runState, nextSequence)
    ) {
      return renderTerminalRunResult(runId, terminalDrain.runState);
    }

    const terminalRunState = terminalDrain.runState;
    if (
      terminalRunState &&
      shouldReturnTerminalRunResult(
        terminalDrain,
        response,
        nextSequence,
        madeSequenceProgress,
        seenResultEvent,
      )
    ) {
      return renderTerminalRunResult(runId, terminalRunState);
    }

    if (shouldDrainNextEventPage(response, madeSequenceProgress)) {
      continue;
    }

    await sleep(
      terminalDrain.runState
        ? TERMINAL_DRAIN_POLL_INTERVAL_MS
        : POLL_INTERVAL_MS,
    );
  }
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
