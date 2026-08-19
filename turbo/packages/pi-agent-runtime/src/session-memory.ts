import { randomUUID } from "node:crypto";

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Api,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type Tool,
} from "@earendil-works/pi-ai";
import type {
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";

const CURRENT_SESSION_VERSION = 3;
const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

export interface PiSessionTranscript {
  appendMessage(message: Message): string;
  buildSessionContext(): SessionContext;
  getSessionId(): string;
}

export interface CreateMemoryPiSessionOptions {
  readonly cwd: string;
  readonly id?: string;
  readonly parentSession?: string;
}

export interface RunPiModelTurnOptions<TApi extends Api = Api> {
  readonly model: Model<TApi>;
  readonly session: PiSessionTranscript;
  readonly stream: StreamFunction<TApi, SimpleStreamOptions>;
  readonly systemPrompt: string;
  readonly tools?: Tool[];
  readonly streamOptions?: Omit<SimpleStreamOptions, "sessionId">;
}

export interface RunPiFirstModelTurnOptions<
  TApi extends Api = Api,
> extends RunPiModelTurnOptions<TApi> {
  readonly prompt: string;
  readonly timestamp?: number;
}

export interface PiModelTurnResult {
  readonly assistantMessage: AssistantMessage;
  readonly handoffRequired: boolean;
}

function assertSessionHeader(entry: FileEntry | undefined): SessionHeader {
  if (entry?.type !== "session" || typeof entry.id !== "string") {
    throw new Error("Pi session JSONL must start with a session header");
  }
  return entry;
}

function generateEntryId(existingIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

function serializeFileEntries(entries: readonly FileEntry[]): string {
  return `${entries
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n")}\n`;
}

function parseSessionEntries(jsonl: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of jsonl.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch {
      // Match Pi's file loader: one malformed line does not hide later entries.
    }
  }
  return entries;
}

function migrateSessionEntries(entries: FileEntry[]): void {
  const header = entries.find((entry) => {
    return entry.type === "session";
  });
  const version = header?.version ?? 1;
  if (version < 2) {
    const ids = new Set<string>();
    let previousId: string | null = null;
    for (const entry of entries) {
      if (entry.type === "session") {
        entry.version = 2;
        continue;
      }
      entry.id = generateEntryId(ids);
      entry.parentId = previousId;
      ids.add(entry.id);
      previousId = entry.id;
      if (entry.type === "compaction") {
        const legacy = entry as typeof entry & {
          firstKeptEntryIndex?: number;
        };
        if (typeof legacy.firstKeptEntryIndex === "number") {
          const target = entries[legacy.firstKeptEntryIndex];
          if (target && target.type !== "session") {
            entry.firstKeptEntryId = target.id;
          }
          delete legacy.firstKeptEntryIndex;
        }
      }
    }
  }
  if (version < 3) {
    for (const entry of entries) {
      if (entry.type === "session") {
        entry.version = 3;
      } else if (
        entry.type === "message" &&
        (entry.message as { role?: string }).role === "hookMessage"
      ) {
        (entry.message as { role: string }).role = "custom";
      }
    }
  }
}

function sessionPath(
  entries: readonly SessionEntry[],
  leafId: string | null,
): SessionEntry[] {
  if (leafId === null) {
    return [];
  }
  const byId = new Map(
    entries.map((entry) => {
      return [entry.id, entry] as const;
    }),
  );
  let current = byId.get(leafId) ?? entries.at(-1);
  const path: SessionEntry[] = [];
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function contextEntries(path: readonly SessionEntry[]): SessionEntry[] {
  let compactionIndex = -1;
  for (let index = 0; index < path.length; index += 1) {
    if (path[index]?.type === "compaction") {
      compactionIndex = index;
    }
  }
  if (compactionIndex === -1) {
    return [...path];
  }
  const compaction = path[compactionIndex];
  if (!compaction || compaction.type !== "compaction") {
    return [...path];
  }
  const result: SessionEntry[] = [compaction];
  let keep = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = path[index];
    if (!entry) {
      continue;
    }
    if (entry.id === compaction.firstKeptEntryId) {
      keep = true;
    }
    if (keep) {
      result.push(entry);
    }
  }
  result.push(...path.slice(compactionIndex + 1));
  return result;
}

type PiContextMessage = SessionContext["messages"][number];

function entryContextMessages(entry: SessionEntry): PiContextMessage[] {
  if (entry.type === "message") {
    const message = entry.message;
    if (
      (message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult") &&
      message.content == null
    ) {
      return [{ ...message, content: [] } as PiContextMessage];
    }
    return [message];
  }
  if (entry.type === "custom_message") {
    return [
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: new Date(entry.timestamp).getTime(),
      },
    ];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [
      {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: new Date(entry.timestamp).getTime(),
      },
    ];
  }
  if (entry.type === "compaction") {
    return [
      {
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: new Date(entry.timestamp).getTime(),
      },
    ];
  }
  return [];
}

function buildSessionContext(
  entries: readonly SessionEntry[],
  leafId: string | null,
): SessionContext {
  const path = sessionPath(entries, leafId);
  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = {
        provider: entry.message.provider,
        modelId: entry.message.model,
      };
    }
  }
  return {
    messages: contextEntries(path).flatMap(entryContextMessages),
    thinkingLevel,
    model,
  };
}

function bashExecutionToText(
  message: Extract<PiContextMessage, { role: "bashExecution" }>,
): string {
  let text = `Ran \`${message.command}\`\n`;
  text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
  if (message.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (
    message.exitCode !== null &&
    message.exitCode !== undefined &&
    message.exitCode !== 0
  ) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

function convertToLlm(messages: readonly PiContextMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    switch (message.role) {
      case "bashExecution": {
        return message.excludeFromContext
          ? []
          : [
              {
                role: "user",
                content: [{ type: "text", text: bashExecutionToText(message) }],
                timestamp: message.timestamp,
              },
            ];
      }
      case "custom": {
        return [
          {
            role: "user",
            content:
              typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content,
            timestamp: message.timestamp,
          },
        ];
      }
      case "branchSummary": {
        return [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  BRANCH_SUMMARY_PREFIX +
                  message.summary +
                  BRANCH_SUMMARY_SUFFIX,
              },
            ],
            timestamp: message.timestamp,
          },
        ];
      }
      case "compactionSummary": {
        return [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  COMPACTION_SUMMARY_PREFIX +
                  message.summary +
                  COMPACTION_SUMMARY_SUFFIX,
              },
            ],
            timestamp: message.timestamp,
          },
        ];
      }
      case "user":
      case "assistant":
      case "toolResult": {
        return [message];
      }
    }
  });
}

/**
 * A byte-backed adapter for Pi's native JSONL session format.
 *
 * Its versioned parser, migrations, context projection, and message conversion
 * mirror Pi's native format and are cross-checked against the official runtime.
 * Keeping the compatibility layer small avoids loading Pi's full TUI/RPC entry
 * point during a serverless cold start. Persistence stays under the caller's
 * control, so API runtimes need no temporary filesystem while sandboxes can
 * reopen the returned bytes with SessionManager.open().
 */
export class MemoryPiSession implements PiSessionTranscript {
  readonly #header: SessionHeader;
  readonly #entries: SessionEntry[];
  readonly #entryIds: Set<string>;
  #leafId: string | null;

  private constructor(header: SessionHeader, entries: SessionEntry[]) {
    this.#header = header;
    this.#entries = entries;
    this.#entryIds = new Set(
      entries.map((entry) => {
        return entry.id;
      }),
    );
    this.#leafId = entries.at(-1)?.id ?? null;
  }

  static create(options: CreateMemoryPiSessionOptions): MemoryPiSession {
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: options.id ?? randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: options.cwd,
      parentSession: options.parentSession,
    };
    return new MemoryPiSession(header, []);
  }

  static fromJsonl(jsonl: string): MemoryPiSession {
    const fileEntries = parseSessionEntries(jsonl);
    const header = assertSessionHeader(fileEntries[0]);
    migrateSessionEntries(fileEntries);
    return new MemoryPiSession(header, fileEntries.slice(1) as SessionEntry[]);
  }

  appendMessage(message: Message): string {
    const id = generateEntryId(this.#entryIds);
    const entry: SessionEntry = {
      type: "message",
      id,
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    this.#entries.push(entry);
    this.#entryIds.add(id);
    this.#leafId = id;
    return id;
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.#entries, this.#leafId);
  }

  getEntries(): SessionEntry[] {
    return [...this.#entries];
  }

  getHeader(): SessionHeader {
    return { ...this.#header };
  }

  getSessionId(): string {
    return this.#header.id;
  }

  toJsonl(): string {
    return serializeFileEntries([this.#header, ...this.#entries]);
  }
}

function piReasoningLevel(
  context: SessionContext,
): SimpleStreamOptions["reasoning"] {
  switch (context.thinkingLevel) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max": {
      return context.thinkingLevel;
    }
    default: {
      return undefined;
    }
  }
}

async function consumeAssistantMessage(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessage> {
  for await (const _event of stream) {
    // The first-turn slot persists only the final native Pi message. Streaming
    // projection remains the API caller's responsibility.
  }
  return await stream.result();
}

export function piAssistantRequiresHandoff(message: AssistantMessage): boolean {
  return message.content.some((content) => {
    return content.type === "toolCall";
  });
}

export async function runPiModelTurn<TApi extends Api>(
  options: RunPiModelTurnOptions<TApi>,
): Promise<PiModelTurnResult> {
  const sessionContext = options.session.buildSessionContext();
  const context: Context = {
    systemPrompt: options.systemPrompt,
    messages: convertToLlm(sessionContext.messages),
    tools: options.tools,
  };
  const responseStream = options.stream(options.model, context, {
    ...options.streamOptions,
    reasoning:
      options.streamOptions?.reasoning ?? piReasoningLevel(sessionContext),
    sessionId: options.session.getSessionId(),
  });
  const assistantMessage = await consumeAssistantMessage(responseStream);
  options.session.appendMessage(assistantMessage);
  return {
    assistantMessage,
    handoffRequired: piAssistantRequiresHandoff(assistantMessage),
  };
}

export async function runPiFirstModelTurn<TApi extends Api>(
  options: RunPiFirstModelTurnOptions<TApi>,
): Promise<PiModelTurnResult> {
  options.session.appendMessage({
    role: "user",
    content: options.prompt,
    timestamp: options.timestamp ?? Date.now(),
  });
  return await runPiModelTurn(options);
}
