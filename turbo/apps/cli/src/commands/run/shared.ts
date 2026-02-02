import chalk from "chalk";
import * as fs from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { getEvents, type RunResult } from "../../lib/api";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { parseEvent } from "../../lib/events/event-parser-factory";
import { EventRenderer } from "../../lib/events/event-renderer";
import { CodexEventRenderer } from "../../lib/events/codex-event-renderer";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import {
  streamEvents,
  type StreamResult,
} from "../../lib/realtime/stream-events";

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

export function isUUID(str: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(str);
}

/**
 * Extract var names from compose config
 */
export function extractVarNames(composeContent: unknown): string[] {
  const refs = extractVariableReferences(composeContent);
  const grouped = groupVariablesBySource(refs);
  return grouped.vars.map((r) => r.name);
}

/**
 * Extract secret names from compose config
 */
export function extractSecretNames(composeContent: unknown): string[] {
  const refs = extractVariableReferences(composeContent);
  const grouped = groupVariablesBySource(refs);
  return grouped.secrets.map((r) => r.name);
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
  const missingNames = configNames.filter((name) => !(name in result));

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
          Object.entries(dotenvResult.parsed).filter(([key]) =>
            missingNames.includes(key),
          ),
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
 * Parse identifier with optional scope and version specifier
 * Format: [scope/]name[:version]
 * Examples:
 *   "demo:d084948d"      → { name: "demo", version: "d084948d" }
 *   "demo:latest"        → { name: "demo", version: "latest" }
 *   "demo"               → { name: "demo" }
 *   "lancy/demo"         → { scope: "lancy", name: "demo" }
 *   "lancy/demo:abc123"  → { scope: "lancy", name: "demo", version: "abc123" }
 */
export function parseIdentifier(identifier: string): {
  scope?: string;
  name: string;
  version?: string;
} {
  // UUIDs don't contain colons or slashes, so check first
  if (isUUID(identifier)) {
    return { name: identifier };
  }

  let scope: string | undefined;
  let rest = identifier;

  // Check for scope (contains "/")
  const slashIndex = identifier.indexOf("/");
  if (slashIndex > 0) {
    scope = identifier.slice(0, slashIndex);
    rest = identifier.slice(slashIndex + 1);
  }

  // Parse name:version format using indexOf (version comes after name)
  const colonIndex = rest.indexOf(":");
  if (colonIndex > 0 && colonIndex < rest.length - 1) {
    return {
      scope,
      name: rest.slice(0, colonIndex),
      version: rest.slice(colonIndex + 1),
    };
  }

  return { scope, name: rest };
}

interface PollResult {
  succeeded: boolean;
  runId: string;
  sessionId?: string;
  checkpointId?: string;
}

/**
 * Options for polling/streaming events
 */
interface EventRenderingOptions {
  verbose?: boolean;
}

/**
 * Stream events using Ably realtime (experimental)
 * @returns Stream result with success status and optional session/checkpoint IDs
 */
export async function streamRealtimeEvents(
  runId: string,
  options?: EventRenderingOptions,
): Promise<StreamResult> {
  const renderer = new EventRenderer({ verbose: options?.verbose });

  return streamEvents(runId, {
    onEvent: (event: unknown) => {
      const eventData = event as Record<string, unknown>;
      const parsed = parseEvent(eventData);
      if (parsed) {
        renderer.render(parsed);
      }
    },
    onRunCompleted: (result) => {
      EventRenderer.renderRunCompleted(result as RunResult | undefined);
    },
    onRunFailed: (error, rid) => {
      EventRenderer.renderRunFailed(error, rid);
    },
    onTimeout: (rid) => {
      console.error(chalk.red("\n✗ Run timed out"));
      console.error(
        chalk.dim(`  (use "vm0 logs ${rid} --system" to view system logs)`),
      );
    },
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

      if (response.framework === "codex") {
        // Use Codex renderer for Codex framework
        CodexEventRenderer.render(eventData);
      } else {
        // Use Claude Code renderer (default)
        const parsed = parseEvent(eventData);
        if (parsed) {
          renderer.render(parsed);
        }
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
    }

    // If not complete, wait before next poll
    if (!complete) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
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

/**
 * Handle generic run errors with special case for concurrent run limit
 * This replaces the final `else` clause to avoid adding complexity
 */
function handleGenericRunError(error: Error, commandLabel: string): void {
  if (
    error instanceof ApiRequestError &&
    error.code === "concurrent_run_limit_exceeded"
  ) {
    console.error(chalk.red(`✗ ${commandLabel} failed`));
    console.error(
      chalk.dim(
        `  ${error.message} Use 'vm0 run list' to view runs, 'vm0 run kill <id>' to cancel.`,
      ),
    );
  } else {
    console.error(chalk.red(`✗ ${commandLabel} failed`));
    console.error(chalk.dim(`  ${error.message}`));
  }
}

/**
 * Common error handler for the main run command
 * Handles all standard error cases and calls process.exit(1)
 */
export function handleRunError(error: unknown, identifier: string): void {
  if (error instanceof Error) {
    if (error.message.includes("Not authenticated")) {
      console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
    } else if (error.message.includes("Realtime connection failed")) {
      console.error(chalk.red("✗ Realtime streaming failed"));
      console.error(chalk.dim(`  ${error.message}`));
      console.error(chalk.dim("  Try running without --experimental-realtime"));
    } else if (error.message.startsWith("Version not found:")) {
      console.error(chalk.red(`✗ ${error.message}`));
      console.error(chalk.dim("  Make sure the version hash is correct"));
    } else if (error.message.startsWith("Environment file not found:")) {
      console.error(chalk.red(`✗ ${error.message}`));
    } else if (error.message.includes("not found")) {
      console.error(chalk.red(`✗ Agent not found: ${identifier}`));
      console.error(
        chalk.dim("  Make sure you've composed the agent with: vm0 compose"),
      );
    } else {
      handleGenericRunError(error, "Run");
    }
  } else {
    console.error(chalk.red("✗ An unexpected error occurred"));
  }
  process.exit(1);
}

/**
 * Common error handler for resume/continue commands
 * Handles all standard error cases and calls process.exit(1)
 */
export function handleResumeOrContinueError(
  error: unknown,
  commandLabel: "Continue" | "Resume",
  resourceId: string,
  resourceLabel: "Agent session" | "Checkpoint",
): void {
  if (error instanceof Error) {
    if (error.message.includes("Not authenticated")) {
      console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
    } else if (error.message.includes("Realtime connection failed")) {
      console.error(chalk.red("✗ Realtime streaming failed"));
      console.error(chalk.dim(`  ${error.message}`));
      console.error(chalk.dim("  Try running without --experimental-realtime"));
    } else if (error.message.startsWith("Environment file not found:")) {
      console.error(chalk.red(`✗ ${error.message}`));
    } else if (error.message.includes("not found")) {
      console.error(chalk.red(`✗ ${resourceLabel} not found: ${resourceId}`));
    } else {
      handleGenericRunError(error, commandLabel);
    }
  } else {
    console.error(chalk.red("✗ An unexpected error occurred"));
  }
  process.exit(1);
}
