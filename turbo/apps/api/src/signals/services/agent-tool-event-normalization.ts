import type { OutputToolPayload } from "@okouai/api-contracts/contracts/chat-events";
import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

import type { AgentEvent } from "../../lib/event-consumer/verify";

type ToolAction = OutputToolPayload["action"];
type ToolTerminalStatus = Exclude<OutputToolPayload["status"], "pending">;
type ToolSummaryLifecycle = "pending" | "terminal";
type ToolCorrelationProvider = "claude" | "codex" | "pi";
type ToolEventFramework = AgentRunLaunchSnapshot["framework"] | null;

type NormalizedAgentToolEvent =
  | {
      readonly kind: "correlated";
      readonly provider: ToolCorrelationProvider;
      readonly providerOperationId: string;
      readonly action: ToolAction;
      readonly status: "pending";
      readonly summary: string;
    }
  | {
      readonly kind: "correlated-terminal";
      readonly provider: ToolCorrelationProvider;
      readonly providerOperationId: string;
      readonly status: ToolTerminalStatus;
      readonly requiresPendingOperation?: true;
      readonly standaloneOperation?: {
        readonly action: ToolAction;
        readonly summary: string;
      };
    }
  | {
      readonly kind: "standalone";
      readonly action: ToolAction;
      readonly status: ToolTerminalStatus;
      readonly summary: string;
    };

const TOOL_SUMMARY_MAX_LENGTH = 240;
const TOOL_SUMMARY_ELLIPSIS = "…";
const TOOL_SUMMARY_VERB_BY_ACTION = {
  run: { pending: "Running", terminal: "Ran" },
  read: { pending: "Reading", terminal: "Read" },
  write: { pending: "Writing", terminal: "Wrote" },
  edit: { pending: "Editing", terminal: "Edited" },
} satisfies Record<ToolAction, Record<ToolSummaryLifecycle, string>>;
const MANAGED_TOOL_EXECUTABLE = "exec '/usr/local/bin/guest-tool-exec'";
const MANAGED_TOOL_PREFIX = `${MANAGED_TOOL_EXECUTABLE} --shell "$0" -c `;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlankProviderId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function truncateToolSummary(summary: string): string {
  if (summary.length <= TOOL_SUMMARY_MAX_LENGTH) {
    return summary;
  }

  let end = TOOL_SUMMARY_MAX_LENGTH - TOOL_SUMMARY_ELLIPSIS.length;
  const precedingCodeUnit = summary.charCodeAt(end - 1);
  const followingCodeUnit = summary.charCodeAt(end);
  if (
    precedingCodeUnit >= 55_296 &&
    precedingCodeUnit <= 56_319 &&
    followingCodeUnit >= 56_320 &&
    followingCodeUnit <= 57_343
  ) {
    end--;
  }
  return `${summary.slice(0, end)}${TOOL_SUMMARY_ELLIPSIS}`;
}

function toolSummary(
  action: ToolAction,
  lifecycle: ToolSummaryLifecycle,
  target: unknown,
): string | null {
  if (typeof target !== "string" || target.includes("\0")) {
    return null;
  }
  const normalizedTarget = target.trim().replace(/\s+/gu, " ");
  if (normalizedTarget.length === 0) {
    return null;
  }
  return truncateToolSummary(
    `${TOOL_SUMMARY_VERB_BY_ACTION[action][lifecycle]} ${normalizedTarget}`,
  );
}

/** Re-tense a persisted pending summary when a provider result omits its target. */
export function terminalToolSummary(
  action: OutputToolPayload["action"],
  summary: string,
): string {
  const verbs = TOOL_SUMMARY_VERB_BY_ACTION[action];
  const pendingPrefix = `${verbs.pending} `;
  if (!summary.startsWith(pendingPrefix)) {
    throw new Error(`Pending ${action} tool summary is not progressive`);
  }
  return truncateToolSummary(
    `${verbs.terminal} ${summary.slice(pendingPrefix.length)}`,
  );
}

/** Decode the exact single-quote dialect emitted by shell_quote::quote_shell_arg. */
function decodeCanonicalSingleQuotedWord(value: string): string | null {
  if (!value.startsWith("'")) {
    return null;
  }

  let decoded = "";
  let cursor = 1;
  for (;;) {
    const closingQuote = value.indexOf("'", cursor);
    if (closingQuote === -1) {
      return null;
    }
    decoded += value.slice(cursor, closingQuote);
    if (closingQuote === value.length - 1) {
      return decoded;
    }
    if (value.slice(closingQuote + 1, closingQuote + 4) !== String.raw`\''`) {
      return null;
    }
    decoded += "'";
    cursor = closingQuote + 4;
  }
}

interface DecodedShellSegment {
  readonly value: string;
  readonly nextCursor: number;
}

function decodeDoubleQuotedShellSegment(
  value: string,
  start: number,
): DecodedShellSegment | null {
  if (value[start] !== '"') {
    return null;
  }

  let decoded = "";
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index]!;
    if (character === '"') {
      return { value: decoded, nextCursor: index + 1 };
    }
    if (character === "$" || character === "`") {
      return null;
    }
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) {
      return null;
    }
    if (escaped === "\n") {
      continue;
    }
    if (
      escaped === "\\" ||
      escaped === '"' ||
      escaped === "$" ||
      escaped === "`"
    ) {
      decoded += escaped;
    } else {
      decoded += `\\${escaped}`;
    }
  }
  return null;
}

function decodeSingleQuotedShellSegment(
  value: string,
  start: number,
): DecodedShellSegment | null {
  if (value[start] !== "'") {
    return null;
  }
  const closingQuote = value.indexOf("'", start + 1);
  return closingQuote === -1
    ? null
    : {
        value: value.slice(start + 1, closingQuote),
        nextCursor: closingQuote + 1,
      };
}

/** Decode the exact three-segment outer word emitted for the managed shell. */
function decodeManagedConcatenatedOuterShellWord(value: string): string | null {
  const executableSegment = decodeDoubleQuotedShellSegment(value, 0);
  if (executableSegment?.value !== `${MANAGED_TOOL_EXECUTABLE} --shell "`) {
    return null;
  }
  const shellArgumentSegment = decodeSingleQuotedShellSegment(
    value,
    executableSegment.nextCursor,
  );
  if (shellArgumentSegment?.value !== '$0" -c ') {
    return null;
  }
  const commandSegment = decodeDoubleQuotedShellSegment(
    value,
    shellArgumentSegment.nextCursor,
  );
  if (commandSegment?.nextCursor !== value.length) {
    return null;
  }
  return decodeCanonicalSingleQuotedWord(commandSegment.value);
}

/** Decode one strictly bounded shell word used as the outer bash command argument. */
function decodeOuterShellWord(value: string): string | null {
  const singleQuoted = decodeCanonicalSingleQuotedWord(value);
  if (singleQuoted !== null) {
    return singleQuoted;
  }

  const doubleQuoted = decodeDoubleQuotedShellSegment(value, 0);
  if (doubleQuoted !== null) {
    return doubleQuoted.nextCursor === value.length ? doubleQuoted.value : null;
  }

  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : null;
}

function decodedToolCommand(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) {
    return null;
  }
  let command = value.trim();
  if (command.length === 0) {
    return null;
  }

  const outer = /^\/bin\/bash -(?:c|lc) ([\s\S]+)$/u.exec(command);
  if (outer) {
    const outerWord = outer[1]!;
    const decodedOuter = decodeOuterShellWord(outerWord);
    if (decodedOuter === null) {
      return decodeManagedConcatenatedOuterShellWord(outerWord);
    }
    command = decodedOuter;
  } else if (/^\/bin\/bash -(?:c|lc)(?:\s|$)/u.test(command)) {
    return null;
  }

  if (command.startsWith(MANAGED_TOOL_PREFIX)) {
    return decodeCanonicalSingleQuotedWord(
      command.slice(MANAGED_TOOL_PREFIX.length),
    );
  }
  if (command.startsWith(MANAGED_TOOL_EXECUTABLE)) {
    return null;
  }
  return command;
}

function singleMessageContentBlock(
  event: AgentEvent,
): Record<string, unknown> | null {
  const message = recordOf(event.message);
  const content = message?.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return null;
  }
  return recordOf(content[0]);
}

function claudeToolUse(event: AgentEvent): NormalizedAgentToolEvent | null {
  if (event.type !== "assistant") {
    return null;
  }
  const block = singleMessageContentBlock(event);
  if (block?.type !== "tool_use") {
    return null;
  }
  const providerOperationId = nonBlankProviderId(block.id);
  const input = recordOf(block.input);
  if (providerOperationId === null || input === null) {
    return null;
  }

  let action: ToolAction;
  let summary: string | null;
  if (typeof block.name === "string" && block.name.toLowerCase() === "bash") {
    action = "run";
    summary = toolSummary("run", "pending", decodedToolCommand(input.command));
  } else {
    switch (block.name) {
      case "Read": {
        action = "read";
        summary = toolSummary("read", "pending", input.file_path);
        break;
      }
      case "Write": {
        action = "write";
        summary = toolSummary("write", "pending", input.file_path);
        break;
      }
      case "Edit": {
        action = "edit";
        summary = toolSummary("edit", "pending", input.file_path);
        break;
      }
      case "NotebookEdit": {
        action = "edit";
        summary =
          toolSummary("edit", "pending", input.notebook_path) ??
          toolSummary("edit", "pending", input.file_path);
        break;
      }
      default: {
        return null;
      }
    }
  }
  if (summary === null) {
    return null;
  }
  return {
    kind: "correlated",
    provider: "claude",
    providerOperationId,
    action,
    status: "pending",
    summary,
  };
}

function claudeToolResult(event: AgentEvent): NormalizedAgentToolEvent | null {
  if (event.type !== "user") {
    return null;
  }
  const block = singleMessageContentBlock(event);
  if (block?.type !== "tool_result") {
    return null;
  }
  const providerOperationId = nonBlankProviderId(block.tool_use_id);
  if (providerOperationId === null) {
    return null;
  }
  return {
    kind: "correlated-terminal",
    provider: "claude",
    providerOperationId,
    status: block.is_error === true ? "error" : "success",
  };
}

function hasNormalizedErrorSignal(item: Record<string, unknown>): boolean {
  return ["error", "failure_reason", "failureReason"].some((field) => {
    return Object.hasOwn(item, field) && item[field] !== null;
  });
}

function codexTerminalStatus(
  item: Record<string, unknown>,
): ToolTerminalStatus | null {
  if (item.status === "declined") {
    return "cancelled";
  }
  if (item.status === "failed") {
    return "error";
  }
  if (item.status !== "completed") {
    return null;
  }
  if (Object.hasOwn(item, "exit_code") && typeof item.exit_code !== "number") {
    return null;
  }
  return (typeof item.exit_code === "number" && item.exit_code !== 0) ||
    hasNormalizedErrorSignal(item)
    ? "error"
    : "success";
}

function codexCommand(event: AgentEvent): NormalizedAgentToolEvent | null {
  if (event.type !== "item.started" && event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (item?.type !== "command_execution") {
    return null;
  }
  const providerOperationId = nonBlankProviderId(item.id);
  if (providerOperationId === null) {
    return null;
  }
  if (event.type === "item.started") {
    const summary = toolSummary(
      "run",
      "pending",
      decodedToolCommand(item.command),
    );
    if (item.status !== "in_progress" || summary === null) {
      return null;
    }
    return {
      kind: "correlated",
      provider: "codex",
      providerOperationId,
      action: "run",
      status: "pending",
      summary,
    };
  }

  const status = codexTerminalStatus(item);
  if (status === null) {
    return null;
  }
  const summary = toolSummary(
    "run",
    "terminal",
    decodedToolCommand(item.command),
  );
  if (summary === null) {
    return null;
  }
  return {
    kind: "correlated-terminal",
    provider: "codex",
    providerOperationId,
    status,
    standaloneOperation: { action: "run", summary },
  };
}

function codexFile(event: AgentEvent): NormalizedAgentToolEvent | null {
  if (event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (item === null) {
    return null;
  }
  if (nonBlankProviderId(item.id) === null) {
    return null;
  }
  const status = codexTerminalStatus(item);
  if (status === null) {
    return null;
  }

  let action: ToolAction;
  let target: unknown;
  switch (item.type) {
    case "file_read": {
      action = "read";
      target = item.path;
      break;
    }
    case "file_write": {
      action = "write";
      target = item.path;
      break;
    }
    case "file_edit": {
      action = "edit";
      target = item.path;
      break;
    }
    case "file_change": {
      if (!Array.isArray(item.changes) || item.changes.length !== 1) {
        return null;
      }
      const change = recordOf(item.changes[0]);
      if (change?.kind === "add") {
        action = "write";
      } else if (change?.kind === "modify") {
        action = "edit";
      } else {
        return null;
      }
      target = change.path;
      break;
    }
    default: {
      return null;
    }
  }

  const summary = toolSummary(action, "terminal", target);
  return summary === null
    ? null
    : { kind: "standalone", action, status, summary };
}

function piToolUse(event: AgentEvent): NormalizedAgentToolEvent | null {
  if (event.type !== "assistant") {
    return null;
  }
  const block = singleMessageContentBlock(event);
  if (block?.type !== "tool_use") {
    return null;
  }
  const providerOperationId = nonBlankProviderId(block.id);
  const input = recordOf(block.input);
  if (providerOperationId === null || input === null) {
    return null;
  }

  let action: ToolAction;
  let target: unknown;
  switch (block.name) {
    case "bash": {
      action = "run";
      target = decodedToolCommand(input.command);
      break;
    }
    case "read": {
      action = "read";
      target = input.path;
      break;
    }
    case "write": {
      action = "write";
      target = input.path;
      break;
    }
    case "edit": {
      action = "edit";
      target = input.path;
      break;
    }
    default: {
      return null;
    }
  }
  const summary = toolSummary(action, "pending", target);
  if (summary === null) {
    return null;
  }
  return {
    kind: "correlated",
    provider: "pi",
    providerOperationId,
    action,
    status: "pending",
    summary,
  };
}

function piToolResult(event: AgentEvent): NormalizedAgentToolEvent | null {
  if (event.type !== "user") {
    return null;
  }
  const block = singleMessageContentBlock(event);
  if (block?.type !== "tool_result" || typeof block.is_error !== "boolean") {
    return null;
  }
  const providerOperationId = nonBlankProviderId(block.tool_use_id);
  if (providerOperationId === null) {
    return null;
  }
  const cancelled = block.vm0_user_cancelled === true;
  return {
    kind: "correlated-terminal",
    provider: "pi",
    providerOperationId,
    status: cancelled ? "cancelled" : block.is_error ? "error" : "success",
    ...(cancelled ? { requiresPendingOperation: true } : {}),
  };
}

function normalizeClaudeToolEvent(
  event: AgentEvent,
): NormalizedAgentToolEvent | null {
  return claudeToolUse(event) ?? claudeToolResult(event);
}

function normalizeCodexToolEvent(
  event: AgentEvent,
): NormalizedAgentToolEvent | null {
  return codexCommand(event) ?? codexFile(event);
}

function normalizePiToolEvent(
  event: AgentEvent,
): NormalizedAgentToolEvent | null {
  return piToolUse(event) ?? piToolResult(event);
}

/** Normalize one already-masked, already-sequenced provider event. */
export function normalizeAgentToolEvent(
  event: AgentEvent,
  framework: ToolEventFramework,
): NormalizedAgentToolEvent | null {
  switch (framework) {
    case "claude-code": {
      return normalizeClaudeToolEvent(event);
    }
    case "codex": {
      return normalizeCodexToolEvent(event);
    }
    case "pi": {
      return normalizePiToolEvent(event);
    }
    case null: {
      return normalizeClaudeToolEvent(event) ?? normalizeCodexToolEvent(event);
    }
  }
}
