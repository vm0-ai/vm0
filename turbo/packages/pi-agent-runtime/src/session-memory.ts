import { randomUUID } from "node:crypto";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  ModelThinkingLevel,
  StreamFunction,
  Tool,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import { UnsupportedPiSessionVersionError } from "./errors";
import type { PiApiFirstTurnOwnership } from "./provider-ownership";
import type { PiAgentStreamOptions } from "./stream-options";

interface CreateMemoryPiSessionOptions {
  readonly cwd: string;
  readonly id: string;
  readonly parentSession?: string;
  readonly timestamp?: string;
}

interface RunPiFirstModelTurnOptions<TApi extends Api = Api> {
  readonly model: Model<TApi>;
  readonly session: MemoryPiSession;
  readonly stream: StreamFunction<TApi, PiAgentStreamOptions>;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly prompt: string;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly timestamp?: number;
  readonly streamOptions?: Omit<PiAgentStreamOptions, "sessionId">;
  readonly ownership: PiApiFirstTurnOwnership;
  readonly providerRequestBoundary?: (
    markProviderRequestMayHaveStarted: () => void,
  ) => Promise<void>;
}

interface PiModelTurnResult {
  readonly assistantMessage: AssistantMessage;
  readonly handoffRequired: boolean;
}

type NewMemorySessionEntry =
  | { readonly type: "message"; readonly message: Message }
  | {
      readonly type: "model_change";
      readonly provider: string;
      readonly modelId: string;
    }
  | {
      readonly type: "thinking_level_change";
      readonly thinkingLevel: string;
    };

// Keep the memory-backed API slot aligned with the pinned Pi SDK. Pi applies
// this default when opening a new session, and when opening an older session
// that has messages but no explicit thinking_level_change entry.
const PI_DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

function assertSessionHeader(entry: FileEntry | undefined): SessionHeader {
  if (entry?.type !== "session" || typeof entry.id !== "string") {
    throw new Error("Pi session JSONL must start with a session header");
  }
  return entry;
}

function serializeFileEntries(entries: readonly FileEntry[]): string {
  return `${entries
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n")}\n`;
}

function assertStrictJsonl(jsonl: string): void {
  for (const line of jsonl.split("\n")) {
    if (line.trim()) {
      JSON.parse(line);
    }
  }
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

/** Byte-backed adapter around Pi's exported parser, migrations, and context projection. */
export class MemoryPiSession {
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
      id: options.id,
      timestamp: options.timestamp ?? new Date().toISOString(),
      cwd: options.cwd,
      parentSession: options.parentSession,
    };
    return new MemoryPiSession(header, []);
  }

  static fromJsonl(jsonl: string): MemoryPiSession {
    // Pi's exported parser intentionally skips malformed lines so an
    // interactive local session can recover. Checkpoint boundaries cannot do
    // that: silently dropping one line would change the canonical history.
    assertStrictJsonl(jsonl);
    const entries = parseSessionEntries(jsonl);
    const header = assertSessionHeader(entries[0]);
    if (
      header.version !== undefined &&
      header.version > CURRENT_SESSION_VERSION
    ) {
      throw new UnsupportedPiSessionVersionError(
        `Pi session version ${header.version} is newer than supported version ${CURRENT_SESSION_VERSION}`,
      );
    }
    migrateSessionEntries(entries);
    if (header.version !== CURRENT_SESSION_VERSION) {
      throw new UnsupportedPiSessionVersionError(
        "Pi session could not be migrated to the current version",
      );
    }
    return new MemoryPiSession(header, entries.slice(1) as SessionEntry[]);
  }

  appendMessage(message: Message): string {
    return this.#appendEntry({ type: "message", message });
  }

  #appendEntry(entry: NewMemorySessionEntry): string {
    const id = generateEntryId(this.#entryIds);
    const completeEntry = {
      ...entry,
      id,
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    this.#entries.push(completeEntry);
    this.#entryIds.add(id);
    this.#leafId = id;
    return id;
  }

  #activeBranch(): SessionEntry[] {
    const byId = new Map(
      this.#entries.map((entry) => {
        return [entry.id, entry] as const;
      }),
    );
    const branch: SessionEntry[] = [];
    let current = this.#leafId ? byId.get(this.#leafId) : undefined;
    while (current) {
      branch.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return branch.reverse();
  }

  /** Mirror the official Pi SDK's persisted model and thinking defaults. */
  prepareModelTurn<TApi extends Api>(
    model: Model<TApi>,
    thinkingLevel: ModelThinkingLevel = PI_DEFAULT_THINKING_LEVEL,
  ): void {
    const branch = this.#activeBranch();
    const hasMessages = branch.some((entry) => {
      return entry.type === "message";
    });
    if (!hasMessages) {
      this.#appendEntry({
        type: "model_change",
        provider: model.provider,
        modelId: model.id,
      });
    }
    const hasThinkingEntry = branch.some((entry) => {
      return entry.type === "thinking_level_change";
    });
    if (!hasThinkingEntry) {
      this.#appendEntry({
        type: "thinking_level_change",
        thinkingLevel: clampThinkingLevel(model, thinkingLevel),
      });
    }
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.#entries, this.#leafId);
  }

  /** Return the canonical active branch used by Pi's public session helpers. */
  getBranchEntries(): SessionEntry[] {
    return this.#activeBranch();
  }

  hasPendingToolCalls(): boolean {
    const messages = this.buildSessionContext().messages;
    const resolvedIds = new Set(
      messages.flatMap((message) => {
        return message.role === "toolResult" ? [message.toolCallId] : [];
      }),
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") {
        continue;
      }
      return message.content.some((content) => {
        return content.type === "toolCall" && !resolvedIds.has(content.id);
      });
    }
    return false;
  }

  isSettledCheckpoint(): boolean {
    const lastMessage = this.buildSessionContext().messages.at(-1);
    return (
      lastMessage?.role === "assistant" &&
      lastMessage.stopReason !== "error" &&
      lastMessage.stopReason !== "aborted" &&
      !this.hasPendingToolCalls()
    );
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
): PiAgentStreamOptions["reasoning"] {
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
    // The API slot commits only the final native Pi message.
  }
  return await stream.result();
}

function piAssistantRequiresHandoff(message: AssistantMessage): boolean {
  return message.content.some((content) => {
    return content.type === "toolCall";
  });
}

export async function runPiFirstModelTurn<TApi extends Api>(
  options: RunPiFirstModelTurnOptions<TApi>,
): Promise<PiModelTurnResult> {
  options.session.prepareModelTurn(options.model, options.thinkingLevel);
  options.session.appendMessage({
    role: "user",
    content: options.prompt,
    timestamp: options.timestamp ?? Date.now(),
  });
  const sessionContext = options.session.buildSessionContext();
  const context: Context = {
    systemPrompt: options.systemPrompt,
    messages: convertToLlm(sessionContext.messages),
    tools: [...options.tools],
  };
  if (options.providerRequestBoundary) {
    await options.providerRequestBoundary(() => {
      options.ownership.markProviderRequestMayHaveStarted();
    });
    if (options.ownership.stage !== "provider-may-have-started") {
      throw new Error(
        "Pi provider request boundary returned without claiming ownership",
      );
    }
  } else {
    options.ownership.markProviderRequestMayHaveStarted();
  }
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
