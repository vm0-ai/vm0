/**
 * Tool-specific formatters for CLI output
 * Formats tool_use and tool_result events in grouped output
 */

import chalk from "chalk";

export interface ToolUseData {
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultData {
  result: string;
  isError: boolean;
}

/**
 * Pluralize a word based on count
 */
function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Format the header line for a tool (e.g., "Read src/lib/api.ts")
 */
export function formatToolHeader(data: ToolUseData): string[] {
  const { tool, input } = data;

  // Get the headline based on tool type
  const headline = getToolHeadline(tool, input);
  return [headline];
}

/**
 * Tool headline formatters - maps tool name to headline generator
 */
const toolHeadlineFormatters: Record<
  string,
  (input: Record<string, unknown>) => string
> = {
  Read: (input) => `Read(${chalk.dim(String(input.file_path || ""))})`,
  Edit: (input) => `Edit(${chalk.dim(String(input.file_path || ""))})`,
  Write: (input) => `Write(${chalk.dim(String(input.file_path || ""))})`,
  Bash: (input) =>
    `Bash(${chalk.dim(truncate(String(input.command || ""), 60))})`,
  Glob: (input) => `Glob(${chalk.dim(String(input.pattern || ""))})`,
  Grep: (input) => `Grep(${chalk.dim(String(input.pattern || ""))})`,
  Task: (input) =>
    `Task(${chalk.dim(truncate(String(input.description || ""), 60))})`,
  WebFetch: (input) =>
    `WebFetch(${chalk.dim(truncate(String(input.url || ""), 60))})`,
  WebSearch: (input) =>
    `WebSearch(${chalk.dim(truncate(String(input.query || ""), 60))})`,
  TodoWrite: () => "TodoWrite",
};

/**
 * Get the headline for a tool based on its type and input
 */
function getToolHeadline(tool: string, input: Record<string, unknown>): string {
  const formatter = toolHeadlineFormatters[tool];
  return formatter ? formatter(input) : tool;
}

/**
 * Format the result line with content preview
 */
export function formatToolResult(
  toolUse: ToolUseData,
  result: ToolResultData,
  verbose: boolean,
): string[] {
  const { tool, input } = toolUse;
  const { result: resultText, isError } = result;
  const lines: string[] = [];

  // Special handling for TodoWrite - show the task list
  if (tool === "TodoWrite" && !isError) {
    const todoLines = formatTodoList(input);
    lines.push(...todoLines);
    return lines;
  }

  // Special handling for Edit - show diff format
  if (tool === "Edit" && !isError) {
    const editLines = formatEditDiff(input, verbose);
    lines.push(...editLines);
    return lines;
  }

  // Special handling for Write - show content preview
  if (tool === "Write" && !isError) {
    const writeLines = formatWritePreview(input, verbose);
    lines.push(...writeLines);
    return lines;
  }

  // Error case: show error message
  if (isError) {
    const errorMsg = resultText ? truncate(resultText, 80) : "Error";
    lines.push(`└ ✗ ${chalk.dim(errorMsg)}`);
    return lines;
  }

  // Success case: show content preview
  if (resultText) {
    const resultLines = resultText.split("\n");
    if (verbose) {
      // In verbose mode, show full result with └ on first line
      for (let i = 0; i < resultLines.length; i++) {
        const prefix = i === 0 ? "└ " : "  ";
        lines.push(`${prefix}${chalk.dim(resultLines[i])}`);
      }
    } else if (resultLines.length > 0) {
      // In normal mode, show first 3 lines with expand hint
      const previewCount = Math.min(3, resultLines.length);
      for (let i = 0; i < previewCount; i++) {
        const prefix = i === 0 ? "└ " : "  ";
        lines.push(`${prefix}${chalk.dim(resultLines[i])}`);
      }
      const remaining = resultLines.length - previewCount;
      if (remaining > 0) {
        lines.push(
          `  ${chalk.dim(`… +${remaining} ${pluralize(remaining, "line", "lines")} (vm0 logs <runId> to see all)`)}`,
        );
      }
    }
  } else {
    // No result content, show done
    lines.push(`└ ✓ ${chalk.dim("Done")}`);
  }

  return lines;
}

/**
 * Format Write tool output with content preview
 */
function formatWritePreview(
  input: Record<string, unknown>,
  verbose: boolean,
): string[] {
  const lines: string[] = [];
  const content = String(input.content || "");
  const contentLines = content.split("\n");
  const totalLines = contentLines.length;

  // Show content preview
  if (verbose) {
    for (let i = 0; i < contentLines.length; i++) {
      const prefix = i === 0 ? "⎿ " : "  ";
      lines.push(`${prefix}${chalk.dim(contentLines[i] ?? "")}`);
    }
  } else {
    const previewCount = Math.min(3, totalLines);
    for (let i = 0; i < previewCount; i++) {
      const prefix = i === 0 ? "⎿ " : "  ";
      lines.push(`${prefix}${chalk.dim(contentLines[i] ?? "")}`);
    }
    const remaining = totalLines - previewCount;
    if (remaining > 0) {
      lines.push(
        `  ${chalk.dim(`… +${remaining} ${pluralize(remaining, "line", "lines")} (vm0 logs <runId> to see all)`)}`,
      );
    }
  }

  return lines;
}

/**
 * Format Edit tool output as diff
 * Shows added/removed line counts and preview of changes
 */
function formatEditDiff(
  input: Record<string, unknown>,
  verbose: boolean,
): string[] {
  const lines: string[] = [];
  const oldString = String(input.old_string || "");
  const newString = String(input.new_string || "");

  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const removed = oldLines.length;
  const added = newLines.length;

  // Summary line
  const summary = `Added ${added} ${pluralize(added, "line", "lines")}, removed ${removed} ${pluralize(removed, "line", "lines")}`;
  lines.push(`⎿ ${chalk.dim(summary)}`);

  if (verbose) {
    // Verbose mode: show all lines
    for (const line of oldLines) {
      lines.push(`  ${chalk.dim(`- ${line}`)}`);
    }
    for (const line of newLines) {
      lines.push(`  ${chalk.dim(`+ ${line}`)}`);
    }
  } else {
    // Compact mode: show first few lines of each
    const previewLimit = 3;
    const showOld = Math.min(previewLimit, oldLines.length);
    const showNew = Math.min(previewLimit, newLines.length);

    // Show removed lines
    for (let i = 0; i < showOld; i++) {
      lines.push(`  ${chalk.dim(`- ${truncate(oldLines[i] ?? "", 60)}`)}`);
    }
    const remainingOld = oldLines.length - previewLimit;
    if (remainingOld > 0) {
      lines.push(
        `  ${chalk.dim(`  … +${remainingOld} ${pluralize(remainingOld, "line", "lines")} (vm0 logs <runId> to see all)`)}`,
      );
    }

    // Show added lines
    for (let i = 0; i < showNew; i++) {
      lines.push(`  ${chalk.dim(`+ ${truncate(newLines[i] ?? "", 60)}`)}`);
    }
    const remainingNew = newLines.length - previewLimit;
    if (remainingNew > 0) {
      lines.push(
        `  ${chalk.dim(`  … +${remainingNew} ${pluralize(remainingNew, "line", "lines")} (vm0 logs <runId> to see all)`)}`,
      );
    }
  }

  return lines;
}

/**
 * Format TodoWrite task list with status icons
 * ✓ completed, ▸ in_progress, ◻ pending
 */
function formatTodoList(input: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const todos = input.todos as
    | Array<{
        id?: string;
        content?: string;
        status?: string;
      }>
    | undefined;

  if (!todos || !Array.isArray(todos)) {
    lines.push("└ ✓ Done");
    return lines;
  }

  for (const todo of todos) {
    const content = todo.content || "Unknown task";
    const status = todo.status || "pending";
    const icon = getTodoStatusIcon(status);
    const styledContent = formatTodoContent(content, status);
    lines.push(`  ${icon} ${styledContent}`);
  }

  return lines;
}

/**
 * Get icon for todo status
 */
function getTodoStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "▸";
    case "pending":
    default:
      return "◻";
  }
}

/**
 * Format todo content with styling based on status
 * - completed: strikethrough + dim
 * - pending: dim
 */
function formatTodoContent(content: string, status: string): string {
  switch (status) {
    case "completed":
      return chalk.dim.strikethrough(content);
    case "in_progress":
      return content;
    case "pending":
    default:
      return chalk.dim(content);
  }
}
