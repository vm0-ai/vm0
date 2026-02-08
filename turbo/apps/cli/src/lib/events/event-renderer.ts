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
import type { RunResult } from "../api";
import { getFrameworkDisplayName, isSupportedFramework } from "@vm0/core";
import {
  formatToolHeader,
  formatToolResult,
  type ToolUseData,
  type ToolResultData,
} from "./tool-formatters";

/**
 * Info about a started run
 */
interface RunStartedInfo {
  runId: string;
  sandboxId?: string;
}

/**
 * Options for creating an EventRenderer instance
 */
interface EventRendererOptions {
  /** Whether to show timestamp prefix (useful for historical log viewing) */
  showTimestamp?: boolean;
  /** Whether to show verbose output (full tool inputs/outputs) */
  verbose?: boolean;
  /** Whether to buffer tool_use events and wait for tool_result (default: true for streaming) */
  buffered?: boolean;
}

/**
 * Stateful event renderer that buffers tool_use events
 * and displays them grouped with their tool_result
 */
export class EventRenderer {
  private pendingToolUse = new Map<
    string,
    { toolUse: ToolUseData; prefix: string }
  >();
  private options: EventRendererOptions;
  private lastEventType: string | null = null;
  private frameworkDisplayName: string = "Agent";

  constructor(options?: EventRendererOptions) {
    this.options = options ?? {};
  }

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
   * Format timestamp for display (without milliseconds, matching metrics format)
   */
  static formatTimestamp(timestamp: Date): string {
    return timestamp.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /**
   * Render a parsed event to console
   */
  render(event: ParsedEvent): void {
    const timestampPrefix = this.options.showTimestamp
      ? `[${EventRenderer.formatTimestamp(event.timestamp)}] `
      : "";

    switch (event.type) {
      case "init":
        this.renderInit(event, timestampPrefix);
        break;
      case "text":
        this.renderText(event, timestampPrefix);
        break;
      case "tool_use":
        this.handleToolUse(event, timestampPrefix);
        break;
      case "tool_result":
        this.handleToolResult(event, timestampPrefix);
        break;
      case "result":
        this.renderResult(event, timestampPrefix);
        break;
    }
  }

  /**
   * Render run completed state
   * Note: This is run lifecycle status, not an event
   */
  static renderRunCompleted(result: RunResult | undefined): void {
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
          console.log(
            `    ${name}: ${chalk.dim(EventRenderer.formatVersion(version))}`,
          );
        }
      }

      if (result.volumes && Object.keys(result.volumes).length > 0) {
        console.log(`  Volumes:`);
        for (const [name, version] of Object.entries(result.volumes)) {
          console.log(
            `    ${name}: ${chalk.dim(EventRenderer.formatVersion(version))}`,
          );
        }
      }
    }
  }

  /**
   * Render run failed state
   * Note: This is run lifecycle status, not an event
   */
  static renderRunFailed(error: string | undefined, runId: string): void {
    // Visual separator to distinguish from event stream
    console.error("");
    console.error(chalk.red("✗ Run failed"));
    console.error(`  Error: ${chalk.red(error || "Unknown error")}`);
    console.error(
      chalk.dim(`  (use "vm0 logs ${runId} --system" to view system logs)`),
    );
  }

  /**
   * Handle tool_use event - buffer it for later grouping with result (when buffered)
   * or render immediately (when not buffered, e.g., historical log viewing)
   */
  private handleToolUse(event: ParsedEvent, prefix: string): void {
    const toolUseId = String(event.data.toolUseId || "");
    const tool = String(event.data.tool || "");
    const input = (event.data.input as Record<string, unknown>) || {};
    const toolUseData: ToolUseData = { tool, input };

    // When buffered (default), store for later grouping
    // When not buffered, render immediately
    if (this.options.buffered !== false) {
      this.pendingToolUse.set(toolUseId, { toolUse: toolUseData, prefix });
    } else {
      // Non-buffered: render tool_use header immediately
      this.renderToolUseOnly(toolUseData, prefix);
    }
  }

  /**
   * Render a tool_use event without waiting for result (for historical log viewing)
   */
  private renderToolUseOnly(toolUse: ToolUseData, prefix: string): void {
    // Add spacing before tool if previous was text
    if (this.lastEventType === "text") {
      console.log();
    }

    const cont = this.getContinuationPrefix();
    const headerLines = formatToolHeader(toolUse);

    // First line gets the bullet, rest get simple indent
    for (let i = 0; i < headerLines.length; i++) {
      if (i === 0) {
        console.log(prefix + "● " + headerLines[i]);
      } else {
        console.log(cont + headerLines[i]);
      }
    }
    console.log(); // Empty line after each tool_use
    this.lastEventType = "tool";
  }

  /**
   * Handle tool_result event - lookup buffered tool_use and render grouped
   */
  private handleToolResult(event: ParsedEvent, prefix: string): void {
    const toolUseId = String(event.data.toolUseId || "");
    const result = String(event.data.result || "");
    const isError = Boolean(event.data.isError);

    const pending = this.pendingToolUse.get(toolUseId);

    if (pending) {
      // Render grouped output
      this.renderGroupedTool(pending.toolUse, { result, isError }, prefix);
      this.pendingToolUse.delete(toolUseId);
    }
    // Skip orphan tool_results (no matching tool_use in buffer)
  }

  /**
   * Get continuation prefix (simple indent, no timestamp alignment)
   */
  private getContinuationPrefix(): string {
    return "  ";
  }

  /**
   * Render grouped tool output (tool_use + tool_result together)
   */
  private renderGroupedTool(
    toolUse: ToolUseData,
    result: ToolResultData,
    prefix: string,
  ): void {
    // Add spacing before tool if previous was text
    if (this.lastEventType === "text") {
      console.log();
    }

    const verbose = this.options.verbose ?? false;
    const cont = this.getContinuationPrefix();

    const headerLines = formatToolHeader(toolUse);
    const resultLines = formatToolResult(toolUse, result, verbose);

    // First line gets timestamp + bullet, rest get simple indent
    for (let i = 0; i < headerLines.length; i++) {
      if (i === 0) {
        console.log(prefix + "● " + headerLines[i]);
      } else {
        console.log(cont + headerLines[i]);
      }
    }
    for (const line of resultLines) {
      console.log(cont + line);
    }
    console.log(); // Empty line after each group
    this.lastEventType = "tool";
  }

  private renderInit(event: ParsedEvent, prefix: string): void {
    const frameworkStr = String(event.data.framework || "claude-code");
    const displayName = isSupportedFramework(frameworkStr)
      ? getFrameworkDisplayName(frameworkStr)
      : frameworkStr;
    this.frameworkDisplayName = displayName;
    console.log(prefix + chalk.bold(`▷ ${displayName} Started`));
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
    console.log();
    this.lastEventType = "init";
  }

  private renderText(event: ParsedEvent, prefix: string): void {
    const text = String(event.data.text || "");
    // Text events get a bullet prefix
    console.log(prefix + "● " + text);
    this.lastEventType = "text";
  }

  private renderResult(event: ParsedEvent, prefix: string): void {
    console.log(); // Spacing before result
    const success = Boolean(event.data.success);

    if (success) {
      console.log(
        prefix + chalk.bold(`◆ ${this.frameworkDisplayName} Completed`),
      );
    } else {
      console.log(prefix + chalk.bold(`◆ ${this.frameworkDisplayName} Failed`));
    }

    const durationMs = Number(event.data.durationMs || 0);
    const durationSec = (durationMs / 1000).toFixed(1);
    console.log(`  Duration: ${chalk.dim(durationSec + "s")}`);

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
    this.lastEventType = "result";
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
