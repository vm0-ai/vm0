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
import type { ParsedEvent } from "./event-parser";
import type { RunResult } from "./api-client";

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
    console.log(chalk.blue("▶ Run started"));
    console.log(`  Run ID:   ${chalk.gray(info.runId)}`);
    if (info.sandboxId) {
      console.log(`  Sandbox:  ${chalk.gray(info.sandboxId)}`);
    }
    console.log(chalk.gray(`  (use "vm0 logs ${info.runId}" to view logs)`));
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
          chalk.gray(
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
      console.log(`  Checkpoint:    ${chalk.gray(result.checkpointId)}`);
      console.log(`  Session:       ${chalk.gray(result.agentSessionId)}`);
      console.log(`  Conversation:  ${chalk.gray(result.conversationId)}`);

      // Render artifact and volumes
      if (result.artifact && Object.keys(result.artifact).length > 0) {
        console.log(`  Artifact:`);
        for (const [name, version] of Object.entries(result.artifact)) {
          console.log(
            `    ${name}: ${chalk.gray(this.formatVersion(version))}`,
          );
        }
      }

      if (result.volumes && Object.keys(result.volumes).length > 0) {
        console.log(`  Volumes:`);
        for (const [name, version] of Object.entries(result.volumes)) {
          console.log(
            `    ${name}: ${chalk.gray(this.formatVersion(version))}`,
          );
        }
      }
    }

    // Show total time in verbose mode
    if (options?.verbose && options?.startTimestamp) {
      const totalTime = this.formatTotalTime(options.startTimestamp, now);
      console.log(`  Total time:    ${chalk.gray(totalTime)}`);
    }
  }

  /**
   * Render run failed state
   * Note: This is run lifecycle status, not an event
   */
  static renderRunFailed(error: string | undefined): void {
    // Visual separator to distinguish from event stream
    console.log("");
    console.log(chalk.red("✗ Run failed"));
    console.log(`  Error: ${chalk.red(error || "Unknown error")}`);
  }

  private static renderInit(
    event: ParsedEvent,
    prefix: string,
    suffix: string,
  ): void {
    console.log(
      prefix + chalk.cyan("[init]") + suffix + " Starting Claude Code agent",
    );
    console.log(`  Session: ${chalk.gray(String(event.data.sessionId || ""))}`);
    console.log(`  Model: ${chalk.gray(String(event.data.model || ""))}`);
    console.log(
      `  Tools: ${chalk.gray(
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
    console.log(prefix + chalk.blue("[text]") + suffix + " " + text);
  }

  private static renderToolUse(
    event: ParsedEvent,
    prefix: string,
    suffix: string,
  ): void {
    const tool = String(event.data.tool || "");
    console.log(prefix + chalk.yellow("[tool_use]") + suffix + " " + tool);

    // Show full input without truncation
    const input = event.data.input as Record<string, unknown>;
    if (input && typeof input === "object") {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && value !== null) {
          const displayValue =
            typeof value === "object"
              ? JSON.stringify(value, null, 2)
              : String(value);
          console.log(`  ${key}: ${chalk.gray(displayValue)}`);
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
    console.log(`  ${chalk.gray(result)}`);
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
    console.log(`  Duration: ${chalk.gray(durationSec + "s")}`);

    const cost = Number(event.data.cost || 0);
    console.log(`  Cost: ${chalk.gray("$" + cost.toFixed(4))}`);

    const numTurns = Number(event.data.numTurns || 0);
    console.log(`  Turns: ${chalk.gray(String(numTurns))}`);

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
        `  Tokens: ${chalk.gray(
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
