import type { ReactNode } from "react";
import { highlightText } from "../utils/highlight-text.tsx";
import type { ToolOperation } from "../log-detail/utils.ts";
import { formatDuration } from "./event-card.tsx";
import { StatusDot } from "./status-dot.tsx";

interface ToolSummaryProps {
  operation: ToolOperation;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  timestamp?: string;
}

function checkSearchMatch(
  searchTerm: string | undefined,
  toolName: string,
  keyParam: string,
  resultContent: string | undefined,
): boolean {
  if (!searchTerm || !searchTerm.trim()) {
    return false;
  }
  const lowerSearch = searchTerm.toLowerCase();
  return (
    toolName.toLowerCase().includes(lowerSearch) ||
    keyParam.toLowerCase().includes(lowerSearch) ||
    (resultContent ?? "").toLowerCase().includes(lowerSearch)
  );
}

function ToolSummaryHeader({
  toolName,
  keyParamElement,
  keyParam,
  isError,
  hasResult,
  durationText,
  timestamp,
}: {
  toolName: string;
  keyParamElement: ReactNode;
  keyParam: string;
  isError: boolean;
  hasResult: boolean;
  durationText: string | null;
  timestamp?: string;
}) {
  // Determine status dot variant based on result state
  const getStatusVariant = () => {
    if (isError) {
      return "error";
    }
    if (hasResult) {
      return "success";
    }
    return "pending";
  };

  return (
    <summary className="flex cursor-pointer list-none items-center gap-2 w-full text-left">
      <StatusDot variant={getStatusVariant()} />
      <span className="font-semibold text-sm text-foreground shrink-0">
        {toolName}
      </span>
      {keyParam && (
        <code
          className="text-xs text-muted-foreground font-mono truncate min-w-0 flex-1 mt-px"
          title={keyParam}
        >
          {keyParamElement}
        </code>
      )}
      {!keyParam && <span className="flex-1" />}
      {durationText && (
        <span className="text-xs text-muted-foreground shrink-0">
          {durationText}
        </span>
      )}
      {timestamp && (
        <span className="text-xs text-muted-foreground shrink-0 ml-4">
          {timestamp}
        </span>
      )}
    </summary>
  );
}

export function ToolSummary({
  operation,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
  timestamp,
}: ToolSummaryProps) {
  const { toolName, keyParam, result, input } = operation;
  const isError = result?.isError ?? false;
  const durationMs = result?.durationMs;

  const hasSearchMatch = checkSearchMatch(
    searchTerm,
    toolName,
    keyParam,
    result?.content,
  );

  const durationText =
    durationMs !== undefined ? formatDuration(durationMs) : null;

  const keyParamElement =
    searchTerm && keyParam
      ? highlightText(keyParam, {
          searchTerm,
          currentMatchIndex,
          matchStartIndex,
        }).element
      : keyParam;

  return (
    <details className="group" open={hasSearchMatch}>
      <ToolSummaryHeader
        toolName={toolName}
        keyParamElement={keyParamElement}
        keyParam={keyParam}
        isError={isError}
        hasResult={Boolean(result)}
        durationText={durationText}
        timestamp={timestamp}
      />

      <div className="mt-1 flex items-start gap-1.5 ml-[18px] mr-[100px]">
        <span className="text-muted-foreground text-xs shrink-0">└</span>
        <div className="flex-1 min-w-0 space-y-1">
          {input && Object.keys(input).length > 0 && (
            <ToolInputDetails input={input} toolName={toolName} />
          )}

          {result && (
            <ToolResultDetails
              result={result}
              searchTerm={searchTerm}
              currentMatchIndex={currentMatchIndex}
              matchStartIndex={matchStartIndex}
            />
          )}
        </div>
      </div>
    </details>
  );
}

function shouldFilterKey(lowerName: string, key: string): boolean {
  if (lowerName === "bash" && key === "command") {
    return true;
  }
  if (lowerName === "skill" && ["skill", "args"].includes(key)) {
    return true;
  }
  if (lowerName === "write" && ["file_path", "content"].includes(key)) {
    return true;
  }
  if (
    lowerName === "edit" &&
    ["file_path", "old_string", "new_string"].includes(key)
  ) {
    return true;
  }
  if (["read", "glob", "grep"].includes(lowerName)) {
    if (["file_path", "path", "pattern"].includes(key)) {
      return true;
    }
  }
  if (
    (lowerName === "webfetch" || lowerName === "websearch") &&
    key === "url"
  ) {
    return true;
  }
  return false;
}

function ToolInputDetails({
  input,
  toolName,
}: {
  input: Record<string, unknown>;
  toolName: string;
}) {
  const lowerName = toolName.toLowerCase();

  // Bash - show full command
  if (lowerName === "bash") {
    const command = input.command as string | undefined;
    if (command) {
      return (
        <pre className="font-mono text-xs text-foreground whitespace-pre-wrap break-all overflow-hidden leading-5">
          {command}
        </pre>
      );
    }
  }

  // Skill - show skill name and args with labels
  if (lowerName === "skill") {
    const skill = input.skill as string | undefined;
    const args = input.args as string | undefined;
    if (skill) {
      return (
        <div className="font-mono text-xs">
          <span className="text-muted-foreground">name: </span>
          <span className="text-foreground">{skill}</span>
          {args && (
            <>
              <span className="text-muted-foreground ml-3">args: </span>
              <span className="text-foreground">{args}</span>
            </>
          )}
        </div>
      );
    }
  }

  // Write - show full content
  if (lowerName === "write") {
    const content = input.content as string | undefined;
    if (content) {
      return (
        <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
          {content}
        </pre>
      );
    }
  }

  // Edit - show old_string and new_string
  if (lowerName === "edit") {
    const oldString = input.old_string as string | undefined;
    const newString = input.new_string as string | undefined;
    if (oldString || newString) {
      return (
        <div className="space-y-1">
          {oldString && (
            <div className="flex items-start gap-2">
              <span className="text-red-500 shrink-0">-</span>
              <pre className="font-mono text-xs text-red-500/70 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {oldString}
              </pre>
            </div>
          )}
          {newString && (
            <div className="flex items-start gap-2">
              <span className="text-lime-500 shrink-0">+</span>
              <pre className="font-mono text-xs text-lime-500/70 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {newString}
              </pre>
            </div>
          )}
        </div>
      );
    }
  }

  // For other tools, show key-value pairs inline
  const entries = Object.entries(input).filter(
    ([key]) => !shouldFilterKey(lowerName, key),
  );

  if (entries.length === 0) {
    return null;
  }

  const formatValue = (val: unknown): string => {
    if (typeof val === "string") {
      return val.length > 50 ? `${val.slice(0, 47)}...` : val;
    }
    return JSON.stringify(val);
  };

  const getFullValue = (val: unknown): string => {
    if (typeof val === "string") {
      return val;
    }
    return JSON.stringify(val);
  };

  const fullText = entries
    .map(([key, val]) => `${key}: ${getFullValue(val)}`)
    .join(", ");

  return (
    <span className="text-xs text-muted-foreground" title={fullText}>
      ({entries.map(([key, val]) => `${key}: ${formatValue(val)}`).join(", ")})
    </span>
  );
}

function ToolResultDetails({
  result,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
}: {
  result: NonNullable<ToolOperation["result"]>;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}) {
  const { content, isError, bytes } = result;

  if (!content || content.trim() === "") {
    return (
      <span className="text-xs text-muted-foreground italic">
        (empty output)
      </span>
    );
  }

  const lines = content.split("\n");
  const lineCount = lines.length;
  const isLong = lineCount > 3 || content.length > 300;

  // Check if search matches this content
  const hasSearchMatch =
    searchTerm &&
    searchTerm.trim() &&
    content.toLowerCase().includes(searchTerm.toLowerCase());

  const contentElement = searchTerm
    ? highlightText(content, {
        searchTerm,
        currentMatchIndex,
        matchStartIndex,
      }).element
    : content;

  if (isError) {
    return (
      <pre className="text-xs text-red-500 whitespace-pre-wrap max-h-40 overflow-y-auto break-all">
        {contentElement}
      </pre>
    );
  }

  if (isLong && !hasSearchMatch) {
    const previewText = lines.slice(0, 3).join("\n");
    const remainingLines = lineCount - 3;

    return (
      <div>
        <pre className="text-xs text-foreground whitespace-pre-wrap break-all">
          {previewText}
        </pre>
        <details className="[&[open]>summary]:hidden">
          <summary className="list-none cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            +{remainingLines} lines
            {bytes ? ` (${(bytes / 1024).toFixed(1)} KB)` : ""}
          </summary>
          <pre className="text-xs text-foreground whitespace-pre-wrap max-h-60 overflow-y-auto break-all">
            {lines.slice(3).join("\n")}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <pre className="text-xs text-foreground whitespace-pre-wrap max-h-40 overflow-y-auto break-all">
      {contentElement}
    </pre>
  );
}
