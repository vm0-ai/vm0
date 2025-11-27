/**
 * Event renderer for CLI output
 * Renders parsed events with colors and formatting
 */

import chalk from "chalk";
import type { ParsedEvent } from "./event-parser";

export class EventRenderer {
  /**
   * Render a parsed event to console
   */
  static render(event: ParsedEvent): void {
    switch (event.type) {
      case "init":
        this.renderInit(event);
        break;
      case "text":
        this.renderText(event);
        break;
      case "tool_use":
        this.renderToolUse(event);
        break;
      case "tool_result":
        this.renderToolResult(event);
        break;
      case "result":
        this.renderResult(event);
        break;
      case "vm0_start":
        this.renderVm0Start(event);
        break;
      case "vm0_result":
        this.renderVm0Result(event);
        break;
      case "vm0_error":
        this.renderVm0Error(event);
        break;
    }
  }

  private static renderInit(event: ParsedEvent): void {
    console.log(chalk.cyan("[init]") + " Starting Claude Code agent");
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

  private static renderText(event: ParsedEvent): void {
    const text = String(event.data.text || "");
    console.log(chalk.blue("[text]") + " " + text);
  }

  private static renderToolUse(event: ParsedEvent): void {
    const tool = String(event.data.tool || "");
    console.log(chalk.yellow("[tool_use]") + " " + tool);

    // Show full input without truncation
    const input = event.data.input as Record<string, unknown>;
    if (input && typeof input === "object") {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && value !== null) {
          console.log(`  ${key}: ${chalk.gray(String(value))}`);
        }
      }
    }
  }

  private static renderToolResult(event: ParsedEvent): void {
    const isError = Boolean(event.data.isError);
    const status = isError ? "Error" : "Completed";
    const color = isError ? chalk.red : chalk.green;

    console.log(color("[tool_result]") + " " + status);

    // Show full result without truncation
    const result = String(event.data.result || "");
    console.log(`  ${chalk.gray(result)}`);
  }

  private static renderResult(event: ParsedEvent): void {
    const success = Boolean(event.data.success);
    const status = success ? "✓ completed successfully" : "✗ failed";
    const color = success ? chalk.green : chalk.red;

    console.log(color("[result]") + " " + status);

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

  private static renderVm0Start(event: ParsedEvent): void {
    console.log(chalk.cyan("[vm0_start]") + " Run starting");

    if (event.data.runId) {
      console.log(`  Run ID: ${chalk.gray(String(event.data.runId))}`);
    }

    // Show full prompt without truncation
    const prompt = String(event.data.prompt || "");
    console.log(`  Prompt: ${chalk.gray(prompt)}`);

    if (event.data.agentName) {
      console.log(`  Agent: ${chalk.gray(String(event.data.agentName))}`);
    }
  }

  private static renderVm0Result(event: ParsedEvent): void {
    console.log(chalk.green("[vm0_result]") + " ✓ Run completed successfully");
    console.log(
      `  Checkpoint: ${chalk.gray(String(event.data.checkpointId || ""))}`,
    );
    console.log(
      `  Session: ${chalk.gray(String(event.data.agentSessionId || ""))}`,
    );
    if (event.data.hasArtifact) {
      console.log(`  Artifact: ${chalk.gray("saved")}`);
    }
  }

  private static renderVm0Error(event: ParsedEvent): void {
    console.log(chalk.red("[vm0_error]") + " ✗ Run failed");

    // Handle error as string or object
    let errorMessage = "";
    if (typeof event.data.error === "string") {
      errorMessage = event.data.error;
    } else if (event.data.error && typeof event.data.error === "object") {
      // If error is an object, try to extract message
      const errorObj = event.data.error as Record<string, unknown>;
      if ("message" in errorObj && typeof errorObj.message === "string") {
        errorMessage = errorObj.message;
      } else {
        errorMessage = JSON.stringify(event.data.error);
      }
    }

    console.log(`  Error: ${chalk.red(errorMessage || "Unknown error")}`);
    if (event.data.errorType) {
      console.log(`  Type: ${chalk.gray(String(event.data.errorType))}`);
    }
  }
}
