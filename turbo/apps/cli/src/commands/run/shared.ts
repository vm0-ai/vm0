import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { config as dotenvConfig } from "dotenv";
import { getEvents } from "../../lib/api";
import { parseEvent } from "../../lib/events/event-parser-factory";
import { EventRenderer } from "../../lib/events/event-renderer";
import { CodexEventRenderer } from "../../lib/events/codex-event-renderer";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";

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
 * Load values with priority: CLI args > environment variables > .env file
 *
 * For values referenced in the compose config but not provided via CLI,
 * falls back to environment variables and .env file.
 * CLI-provided values are always passed through.
 *
 * @param cliValues Values passed via CLI flags
 * @param configNames Names referenced in compose config (for env fallback)
 * @returns Merged values object with CLI taking highest priority
 */
export function loadValues(
  cliValues: Record<string, string>,
  configNames: string[],
): Record<string, string> | undefined {
  // Start with CLI-provided values (highest priority, always passed through)
  const result: Record<string, string> = { ...cliValues };

  // For names referenced in config but not provided via CLI, load from env/.env
  const missingNames = configNames.filter((name) => !(name in result));

  if (missingNames.length > 0) {
    // Load .env file if it exists (lowest priority)
    const envFilePath = path.resolve(process.cwd(), ".env");
    let dotenvValues: Record<string, string> = {};

    if (fs.existsSync(envFilePath)) {
      const dotenvResult = dotenvConfig({ path: envFilePath, quiet: true });
      if (dotenvResult.parsed) {
        // Only include keys that are missing
        dotenvValues = Object.fromEntries(
          Object.entries(dotenvResult.parsed).filter(([key]) =>
            missingNames.includes(key),
          ),
        );
      }
    }

    // Get from environment variables (medium priority)
    const envValues: Record<string, string> = {};
    for (const name of missingNames) {
      const envValue = process.env[name];
      if (envValue !== undefined) {
        envValues[name] = envValue;
      }
    }

    // Merge with priority: env > .env (CLI already in result)
    Object.assign(result, dotenvValues, envValues);
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

interface PollOptions {
  verbose?: boolean;
  startTimestamp: Date;
}

interface PollResult {
  succeeded: boolean;
  runId: string;
  sessionId?: string;
  checkpointId?: string;
}

/**
 * Poll for events until run completes (via run.status field)
 * @returns Poll result with success status and optional session/checkpoint IDs
 */
export async function pollEvents(
  runId: string,
  options: PollOptions,
): Promise<PollResult> {
  let nextSequence = 0;
  let complete = false;
  let result: PollResult = { succeeded: true, runId };
  const pollIntervalMs = 1000;
  const startTimestamp = options.startTimestamp;
  let previousTimestamp = startTimestamp;
  const verbose = options.verbose;

  while (!complete) {
    const response = await getEvents(runId, {
      since: nextSequence,
    });

    // Render agent events (use appropriate renderer based on provider from API)
    for (const event of response.events) {
      const eventData = event.eventData as Record<string, unknown>;

      if (response.provider === "codex") {
        // Use Codex renderer for Codex provider
        CodexEventRenderer.render(eventData);
      } else {
        // Use Claude Code renderer (default)
        const parsed = parseEvent(eventData);
        if (parsed) {
          EventRenderer.render(parsed, {
            verbose,
            previousTimestamp,
            startTimestamp,
          });
          previousTimestamp = parsed.timestamp;
        }
      }
    }

    nextSequence = response.nextSequence;

    // Check run status for completion (replaces vm0_result/vm0_error events)
    const runStatus = response.run.status;

    if (runStatus === "completed") {
      complete = true;
      // Render completion info
      EventRenderer.renderRunCompleted(response.run.result, {
        verbose,
        previousTimestamp,
        startTimestamp,
      });
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
 * Log verbose pre-flight messages
 */
export function logVerbosePreFlight(
  action: string,
  details: Array<{ label: string; value: string | undefined }>,
): void {
  console.log(`\n${action}...`);
  for (const { label, value } of details) {
    if (value !== undefined) {
      console.log(chalk.dim(`  ${label}: ${value}`));
    }
  }
  console.log();
  console.log("Executing in sandbox...");
  console.log();
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
