import type { ReactNode } from "react";
import { CopyButton } from "@vm0/ui";
import {
  IconChevronRight,
  IconCheck,
  IconX,
  IconFile,
  IconTerminal,
  IconWorld,
  IconSearch,
  IconListCheck,
} from "@tabler/icons-react";
import { highlightText } from "../utils/highlight-text.tsx";
import type { ToolOperation } from "../log-detail/utils.ts";
import { formatDuration } from "./event-card.tsx";

interface ToolSummaryProps {
  operation: ToolOperation;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}

function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();
  if (name === "bash") {
    return IconTerminal;
  }
  if (name === "webfetch") {
    return IconWorld;
  }
  if (name === "websearch") {
    return IconSearch;
  }
  if (name === "todowrite") {
    return IconListCheck;
  }
  const fileTools = ["read", "write", "edit", "glob", "grep"];
  if (fileTools.some((t) => name.includes(t))) {
    return IconFile;
  }
  return null;
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

function getStatusIcon(isError: boolean, hasResult: boolean) {
  if (isError) {
    return IconX;
  }
  if (hasResult) {
    return IconCheck;
  }
  return null;
}

function ToolSummaryHeader({
  toolName,
  keyParamElement,
  keyParam,
  isError,
  hasResult,
  durationText,
}: {
  toolName: string;
  keyParamElement: ReactNode;
  keyParam: string;
  isError: boolean;
  hasResult: boolean;
  durationText: string | null;
}) {
  const ToolIcon = getToolIcon(toolName);
  const StatusIcon = getStatusIcon(isError, hasResult);
  const statusColor = isError ? "text-red-500" : "text-emerald-500";

  return (
    <summary className="flex cursor-pointer list-none items-center gap-2 w-full text-left hover:bg-accent/50 rounded px-1 -ml-1 transition-colors">
      <IconChevronRight className="h-4 w-4 text-muted-foreground shrink-0 transition-transform group-open:rotate-90" />
      {ToolIcon && (
        <ToolIcon className="h-4 w-4 text-muted-foreground shrink-0" />
      )}
      <span className="font-medium text-sm text-foreground">{toolName}</span>
      {keyParam && (
        <code className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">
          {keyParamElement}
        </code>
      )}
      <span className="flex-1" />
      {StatusIcon && (
        <StatusIcon className={`h-4 w-4 shrink-0 ${statusColor}`} />
      )}
      {durationText && (
        <span className="text-xs text-muted-foreground shrink-0">
          {durationText}
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
    <details
      className="group border-l-2 border-border pl-3 py-1"
      open={hasSearchMatch}
    >
      <ToolSummaryHeader
        toolName={toolName}
        keyParamElement={keyParamElement}
        keyParam={keyParam}
        isError={isError}
        hasResult={Boolean(result)}
        durationText={durationText}
      />

      <div className="mt-2 ml-6 space-y-2">
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
    </details>
  );
}

function shouldFilterKey(lowerName: string, key: string): boolean {
  if (lowerName === "bash" && key === "command") {
    return true;
  }
  if (["read", "write", "edit", "glob", "grep"].includes(lowerName)) {
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
        <div className="flex gap-2 items-start bg-gray-50 rounded-lg px-3 py-2">
          <code className="flex-1 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
            {command}
          </code>
          <CopyButton text={command} className="shrink-0 h-4 w-4 p-0" />
        </div>
      );
    }
  }

  // For other tools, show key-value pairs
  const entries = Object.entries(input).filter(
    ([key]) => !shouldFilterKey(lowerName, key),
  );

  if (entries.length === 0) {
    return null;
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Parameters ({entries.length})
      </summary>
      <div className="mt-1 space-y-1 pl-2">
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-start gap-2">
            <span className="text-muted-foreground shrink-0">{key}:</span>
            <span className="text-foreground break-all">
              {typeof val === "string"
                ? val.length > 100
                  ? `${val.slice(0, 97)}...`
                  : val
                : JSON.stringify(val)}
            </span>
          </div>
        ))}
      </div>
    </details>
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
      <div className="text-xs text-muted-foreground italic">(empty output)</div>
    );
  }

  const lines = content.split("\n");
  const isLong = lines.length > 5 || content.length > 100;

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
      <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs">
        <pre className="whitespace-pre-wrap overflow-x-auto text-red-600 max-h-40 overflow-y-auto">
          {contentElement}
        </pre>
      </div>
    );
  }

  if (isLong && !hasSearchMatch) {
    return (
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Output ({lines.length} lines
          {bytes ? `, ${(bytes / 1024).toFixed(1)} KB` : ""})
        </summary>
        <div className="mt-1 flex gap-2 items-start bg-gray-50 rounded-lg px-3 py-2">
          <pre className="flex-1 text-xs text-foreground whitespace-pre-wrap max-h-40 overflow-y-auto break-all">
            {contentElement}
          </pre>
          <CopyButton text={content} className="shrink-0 h-4 w-4 p-0" />
        </div>
      </details>
    );
  }

  return (
    <div className="flex gap-2 items-start bg-gray-50 rounded-lg px-3 py-2">
      <pre className="flex-1 text-xs text-foreground whitespace-pre-wrap max-h-40 overflow-y-auto break-all">
        {contentElement}
      </pre>
      <CopyButton text={content} className="shrink-0 h-4 w-4 p-0" />
    </div>
  );
}
