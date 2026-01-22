/**
 * Event renderer for Codex CLI
 * Renders raw Codex events directly in [event] format
 */

import chalk from "chalk";

interface FileChange {
  kind: "add" | "modify" | "delete";
  path: string;
}

interface CodexItem {
  id: string;
  type: string;
  status?: string;
  command?: string;
  exit_code?: number;
  aggregated_output?: string;
  text?: string;
  changes?: FileChange[];
  path?: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
  error?: string;
  message?: string;
}

export class CodexEventRenderer {
  /**
   * Check if an event is a Codex event
   */
  static isCodexEvent(event: Record<string, unknown>): boolean {
    const type = event.type as string;
    return (
      type === "thread.started" ||
      type === "turn.started" ||
      type === "turn.completed" ||
      type === "turn.failed" ||
      type?.startsWith("item.") ||
      type === "error"
    );
  }

  /**
   * Render a raw Codex event
   */
  static render(rawEvent: Record<string, unknown>): void {
    const event = rawEvent as unknown as CodexEvent;
    const type = event.type;

    switch (type) {
      case "thread.started":
        this.renderThreadStarted(event);
        break;
      case "turn.started":
        // Skip - not useful for display
        break;
      case "turn.completed":
        this.renderTurnCompleted(event);
        break;
      case "turn.failed":
        this.renderTurnFailed(event);
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.renderItem(event);
        break;
      case "error":
        this.renderError(event);
        break;
    }
  }

  private static renderThreadStarted(event: CodexEvent): void {
    console.log("[thread.started]" + ` ${event.thread_id}`);
  }

  private static renderTurnCompleted(event: CodexEvent): void {
    if (event.usage) {
      const input = event.usage.input_tokens || 0;
      const output = event.usage.output_tokens || 0;
      const cached = event.usage.cached_input_tokens || 0;
      const cachedStr = cached ? ` (${cached} cached)` : "";
      console.log(
        "[turn.completed]" +
          chalk.dim(` ${input} in / ${output} out${cachedStr}`),
      );
    }
  }

  private static renderTurnFailed(event: CodexEvent): void {
    console.log(
      chalk.red("[turn.failed]") + (event.error ? ` ${event.error}` : ""),
    );
  }

  // eslint-disable-next-line complexity -- TODO: refactor complex function
  private static renderItem(event: CodexEvent): void {
    const item = event.item;
    if (!item) return;

    const itemType = item.type;
    const eventType = event.type;

    // Reasoning (thinking)
    if (itemType === "reasoning" && item.text) {
      console.log("[reasoning]" + ` ${item.text}`);
      return;
    }

    // Agent message
    if (itemType === "agent_message" && item.text) {
      console.log("[message]" + ` ${item.text}`);
      return;
    }

    // Command execution
    if (itemType === "command_execution") {
      if (eventType === "item.started" && item.command) {
        console.log("[exec]" + ` ${item.command}`);
      } else if (eventType === "item.completed") {
        const output = item.aggregated_output || "";
        const exitCode = item.exit_code ?? 0;
        if (output) {
          const lines = output.split("\n").filter((l) => l.trim());
          const preview = lines.slice(0, 3).join("\n  ");
          const more =
            lines.length > 3
              ? chalk.dim(` ... (${lines.length - 3} more lines)`)
              : "";
          console.log(
            "[output]" + (exitCode !== 0 ? chalk.red(` exit=${exitCode}`) : ""),
          );
          if (preview) {
            console.log("  " + preview + more);
          }
        } else if (exitCode !== 0) {
          console.log(chalk.red("[output]") + chalk.red(` exit=${exitCode}`));
        }
      }
      return;
    }

    // File changes
    if (itemType === "file_change" && item.changes && item.changes.length > 0) {
      const summary = item.changes
        .map((c) => {
          const icon = c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~";
          return `${icon}${c.path}`;
        })
        .join(", ");
      console.log(chalk.green("[files]") + ` ${summary}`);
      return;
    }

    // File operations (edit/write/read)
    if (
      itemType === "file_edit" ||
      itemType === "file_write" ||
      itemType === "file_read"
    ) {
      const action = itemType.replace("file_", "");
      if (eventType === "item.started" && item.path) {
        console.log(`[${action}]` + ` ${item.path}`);
      }
      return;
    }
  }

  private static renderError(event: CodexEvent): void {
    console.log(
      chalk.red("[error]") +
        ` ${event.message || event.error || "Unknown error"}`,
    );
  }
}
