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
 * Count lines in a string
 */
function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
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
export function formatToolHeader(
  data: ToolUseData,
  verbose: boolean,
): string[] {
  const { tool, input } = data;
  const lines: string[] = [];

  // Get the headline based on tool type
  const headline = getToolHeadline(tool, input);
  lines.push(headline);

  // In verbose mode, show all input parameters
  if (verbose && input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null) {
        const displayValue =
          typeof value === "object"
            ? JSON.stringify(value, null, 2)
            : String(value);
        lines.push(`  ${key}: ${chalk.dim(displayValue)}`);
      }
    }
  }

  return lines;
}

/**
 * Tool headline formatters - maps tool name to headline generator
 */
const toolHeadlineFormatters: Record<
  string,
  (input: Record<string, unknown>) => string
> = {
  Read: (input) => `Read ${String(input.file_path || "")}`,
  Edit: (input) => `Edit ${String(input.file_path || "")}`,
  Write: (input) => `Write ${String(input.file_path || "")}`,
  Bash: (input) =>
    input.description
      ? `Bash: ${truncate(String(input.description), 60)}`
      : `Bash: ${truncate(String(input.command || ""), 60)}`,
  Glob: (input) => `Glob: ${String(input.pattern || "")}`,
  Grep: (input) => `Grep: ${String(input.pattern || "")}`,
  Task: (input) => `Task: ${truncate(String(input.description || ""), 60)}`,
  WebFetch: (input) =>
    `WebFetch: ${chalk.dim(truncate(String(input.url || ""), 60))}`,
  WebSearch: (input) => `WebSearch: ${truncate(String(input.query || ""), 60)}`,
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
 * Format the result line (e.g., "└ ✓ 245 lines")
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

  // Get the result summary based on tool type
  const summary = getToolResultSummary(tool, resultText, isError);
  const statusIcon = isError ? "✗" : "✓";
  lines.push(`└ ${statusIcon} ${chalk.dim(summary)}`);

  // In verbose mode, show full result
  if (verbose && resultText) {
    const resultLines = resultText.split("\n");
    for (const line of resultLines) {
      lines.push(`  ${chalk.dim(line)}`);
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

/**
 * Get the result summary for a tool based on its type
 */
function getToolResultSummary(
  tool: string,
  result: string,
  isError: boolean,
): string {
  if (isError) {
    return "Error";
  }

  switch (tool) {
    case "Read": {
      const lineCount = countLines(result);
      return `${lineCount} lines`;
    }

    case "Edit":
      return "Applied";

    case "Write":
      return "Written";

    case "Bash": {
      // Try to extract exit code from result
      const exitMatch = result.match(/exit code[:\s]*(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : "0";
      const lineCount = countLines(result);
      if (lineCount > 1) {
        return `exit ${exitCode}, +${lineCount} lines`;
      }
      return `exit ${exitCode}`;
    }

    case "Glob": {
      // Count files in result (one per line)
      const fileCount = countLines(result);
      return `${fileCount} files`;
    }

    case "Grep": {
      // Try to count matches
      const lineCount = countLines(result);
      return `${lineCount} matches`;
    }

    case "Task":
      return "Completed";

    case "WebFetch": {
      const lineCount = countLines(result);
      return `Fetched ${lineCount} lines`;
    }

    case "WebSearch": {
      const lineCount = countLines(result);
      return `${lineCount} results`;
    }

    default:
      return "Done";
  }
}
