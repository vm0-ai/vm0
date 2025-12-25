/**
 * Event renderer for CLI output
 * Renders parsed events with colors and formatting
 *
 * Run lifecycle is rendered via:
 * - renderRunStarted: Called immediately after run is created
 * - renderRunCompleted: Called when run completes successfully
 * - renderRunFailed: Called when run fails
 */

import chalk from "chalk";
import type { ParsedEvent } from "./claude-event-parser";
import type { RunResult } from "./api-client";
import { getProviderDisplayName, isSupportedProvider } from "@vm0/core";

/**
 * Info about a started run
 */
export interface RunStartedInfo {
  runId: string;
  sandboxId?: string;
}

/**
 * Options for rendering events
 */
export interface RenderOptions {
  /** Whether to show verbose output including elapsed time */
  verbose?: boolean;
  /** Timestamp of previous event for elapsed time calculation */
  previousTimestamp?: Date;
  /** Start timestamp for total time calculation */
  startTimestamp?: Date;
  /** Whether to show timestamp prefix (useful for historical log viewing) */
  showTimestamp?: boolean;
}

export class EventRenderer {
  /**
   * Render run started info
   * Called immediately after run is created, before polling events
   */
  static renderRunStarted(info: RunStartedInfo): void {
    console.log(chalk.bold("▶ Run started"));
    console.log(`  Run ID:   ${chalk.dim(info.runId)}`);
    if (info.sandboxId) {
      console.log(`  Sandbox:  ${chalk.dim(info.sandboxId)}`);
    }
    console.log(chalk.dim(`  (use "vm0 logs ${info.runId}" to view logs)`));
    console.log();
  }

  /**
   * Format elapsed time between two timestamps
   * Returns [+Nms] for < 1000ms, [+N.Ns] for >= 1000ms
   */
  static formatElapsed(previous: Date, current: Date): string {
    const elapsedMs = current.getTime() - previous.getTime();
    if (elapsedMs < 1000) {
      return `[+${elapsedMs}ms]`;
    }
    return `[+${(elapsedMs / 1000).toFixed(1)}s]`;
  }

  /**
   * Format total elapsed time
   * Returns N.Ns format
   */
  static formatTotalTime(start: Date, end: Date): string {
    const elapsedMs = end.getTime() - start.getTime();
    return `${(elapsedMs / 1000).toFixed(1)}s`;
  }

  /**
   * Format timestamp for display (without milliseconds, matching metrics format)
   */
  static formatTimestamp(timestamp: Date): string {
    return timestamp.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /**
   * Render a parsed event to console
   */
  static render(event: ParsedEvent, options?: RenderOptions): void {
    const timestampPrefix = options?.showTimestamp
      ? `[${this.formatTimestamp(event.timestamp)}] `
      : "";
    const elapsedSuffix =
      options?.verbose && options?.previousTimestamp
        ? " " +
          chalk.dim(
            this.formatElapsed(options.previousTimestamp, event.timestamp),
          )
        : "";
    switch (event.type) {
      case "init":
        this.renderInit(event, timestampPrefix, elapsedSuffix);
        break;
      case "text":
        this.renderText(event, timestampPrefix, elapsedSuffix);
        break;
      case "tool_use":
        this.renderToolUse(event, timestampPrefix, elapsedSuffix);
        break;
      case "tool_result":
        this.renderToolResult(event, timestampPrefix, elapsedSuffix);
        break;
      case "result":
        this.renderResult(event, timestampPrefix, elapsedSuffix);
        break;
    }
  }

  /**
   * Render run completed state
   * Note: This is run lifecycle status, not an event
   */
  static renderRunCompleted(
    result: RunResult | undefined,
    options?: RenderOptions,
  ): void {
    const now = new Date();

    // Visual separator to distinguish from event stream
    console.log("");
    console.log(chalk.green("✓ Run completed successfully"));

    if (result) {
      console.log(`  Checkpoint:    ${chalk.dim(result.checkpointId)}`);
      console.log(`  Session:       ${chalk.dim(result.agentSessionId)}`);
      console.log(`  Conversation:  ${chalk.dim(result.conversationId)}`);

      // Render artifact and volumes
      if (result.artifact && Object.keys(result.artifact).length > 0) {
        console.log(`  Artifact:`);
        for (const [name, version] of Object.entries(result.artifact)) {
          console.log(`    ${name}: ${chalk.dim(this.formatVersion(version))}`);
        }
      }

      if (result.volumes && Object.keys(result.volumes).length > 0) {
        console.log(`  Volumes:`);
        for (const [name, version] of Object.entries(result.volumes)) {
          console.log(`    ${name}: ${chalk.dim(this.formatVersion(version))}`);
        }
      }
    }

    // Show total time in verbose mode
    if (options?.verbose && options?.startTimestamp) {
      const totalTime = this.formatTotalTime(options.startTimestamp, now);
      console.log(`  Total time:    ${chalk.dim(totalTime)}`);
    }
  }

  /**
   * Render run failed state
   * Note: This is run lifecycle status, not an event
   */
  static renderRunFailed(error: string | undefined, runId: string): void {
    // Visual separator to distinguish from event stream
    console.log("");
    console.log(chalk.red("✗ Run failed"));
    console.log(`  Error: ${chalk.red(error || "Unknown error")}`);
    console.log(
      chalk.dim(`  (use "vm0 logs ${runId} --system" to view system logs)`),
    );
  }

  private static renderInit(
    event: ParsedEvent,
    prefix: string,
    suffix: string,
  ): void {
    const providerStr = String(event.data.provider || "claude-code");
    const displayName = isSupportedProvider(providerStr)
      ? getProviderDisplayName(providerStr)
      : providerStr;
    console.log(prefix + "[init]" + suffix + ` Starting ${displayName} agent`);
    console.log(`  Session: ${chalk.dim(String(event.data.sessionId || ""))}`);
    if (event.data.model) {
      console.log(`  Model: ${chalk.dim(String(event.data.model))}`);
    }
    console.log(
      `  Tools: ${chalk.dim(
        Array.isArray(event.data.tools)
          ? event.data.tools.join(", ")
          : String(event.data.tools || ""),
      )}`,
    );
  }

  private static renderText(
    event: ParsedEvent,
    prefix: string,
    suffix: string,
  ): void {
    const text = String(event.data.text || "");
    console.log(prefix + "[text]" + suffix + " " + text);
  }

  private static renderToolUse(
    event: ParsedEvent,
    prefix: string,
    suffix: string,
  ): void {
    const tool = String(event.data.tool || "");
    console.log(prefix + "[tool_use]" + suffix + " " + tool);

    // Show full input without truncation
    const input = event.data.input as Record<string, unknown>;
    if (input && typeof input === "object") {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && value !== null) {
          const displayValue =
            typeof value === "object"
              ? JSON.stringify(value, null, 2)
              : String(value);
          console.log(`  ${key}: ${chalk.dim(displayValue)}`);
        }
      }
    }
  }

  private static renderToolResult(
    event: ParsedEvent,
    prefix: string,
    suffix: string,
  ): void {
    const isError = Boolean(event.data.isError);
    const status = isError ? "Error" : "Completed";
    const color = isError ? chalk.red : chalk.green;

    console.log(prefix + color("[tool_result]") + suffix + " " + status);

    // Show full result without truncation
    const result = String(event.data.result || "");
    console.log(`  ${chalk.dim(result)}`);
  }

  private static renderResult(
    event: ParsedEvent,
    prefix: string,
    suffix: string,
  ): void {
    const success = Boolean(event.data.success);
    const status = success ? "✓ completed successfully" : "✗ failed";
    const color = success ? chalk.green : chalk.red;

    console.log(prefix + color("[result]") + suffix + " " + status);

    const durationMs = Number(event.data.durationMs || 0);
    const durationSec = (durationMs / 1000).toFixed(1);
    console.log(`  Duration: ${chalk.dim(durationSec + "s")}`);

    const cost = Number(event.data.cost || 0);
    console.log(`  Cost: ${chalk.dim("$" + cost.toFixed(4))}`);

    const numTurns = Number(event.data.numTurns || 0);
    console.log(`  Turns: ${chalk.dim(String(numTurns))}`);

    const usage = event.data.usage as Record<string, unknown>;
    if (usage && typeof usage === "object") {
      const inputTokens = Number(usage.input_tokens || 0);
      const outputTokens = Number(usage.output_tokens || 0);

      const formatTokens = (count: number): string => {
        if (count >= 1000) {
          return Math.floor(count / 1000) + "k";
        }
        return String(count);
      };

      console.log(
        `  Tokens: ${chalk.dim(
          `input=${formatTokens(inputTokens)} output=${formatTokens(outputTokens)}`,
        )}`,
      );
    }
  }

  /**
   * Format version ID for display (show short 8-character prefix)
   */
  private static formatVersion(version: string): string {
    // SHA-256 hashes are 64 characters, show first 8
    if (version.length === 64 && /^[a-f0-9]+$/i.test(version)) {
      return version.slice(0, 8);
    }
    // For "latest" or other formats, show as-is
    return version;
  }
}
