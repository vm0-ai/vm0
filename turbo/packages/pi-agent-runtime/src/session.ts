import type {
  AgentEvent,
  AgentMessage,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepository,
  type SqliteDatabase,
  type SqliteDatabaseFactory,
} from "@earendil-works/pi-session-backend-sqlite-node";

import { runPiAgentPrompt } from "./agent-loop";
import type { PiAgentModelConfig } from "./types";

type PersistedMessage = Extract<
  AgentMessage,
  { role: "user" | "assistant" | "toolResult" }
>;

function isPersistedMessage(
  message: AgentMessage,
): message is PersistedMessage {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

function canonicalDurableMessage(message: PersistedMessage): PersistedMessage {
  const serialized = JSON.stringify(message);
  if (serialized === undefined) {
    throw new Error("Pi produced a message that cannot be persisted");
  }
  return JSON.parse(serialized) as PersistedMessage;
}

function checkpointingSqliteFactory(): SqliteDatabaseFactory {
  const factory = createNodeSqliteFactory();
  return {
    async open(path: string): Promise<SqliteDatabase> {
      const database = await factory.open(path);
      return {
        exec(sql: string): void {
          database.exec(sql);
        },
        prepare(sql: string) {
          return database.prepare(sql);
        },
        transaction<T>(operation: () => T): T {
          return database.transaction(operation);
        },
        close(): void {
          try {
            database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            database.close();
          }
        },
      };
    },
  };
}

function finalAssistantMessage(
  messages: readonly PersistedMessage[],
): Extract<PersistedMessage, { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

/**
 * Run one turn against Pi's native SQLite session repository.
 *
 * The caller owns the database file as a single checkpointable artifact. The
 * repository is always closed before this function resolves so WAL state is
 * checkpointed into the database file before guest-agent snapshots it.
 */
export async function runPiAgentSession(
  args: {
    readonly sessionId: string;
    readonly databasePath: string;
    readonly model: PiAgentModelConfig;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly executionEnv: ExecutionEnv;
    readonly onAssistantMessage?: (
      message: Extract<AgentMessage, { role: "assistant" }>,
    ) => Promise<void> | void;
  },
  signal: AbortSignal,
): Promise<{
  readonly messages: readonly PersistedMessage[];
  readonly finalAssistantMessage:
    | Extract<PersistedMessage, { role: "assistant" }>
    | undefined;
}> {
  const repository = new SqliteSessionRepository({
    env: args.executionEnv,
    sqlite: checkpointingSqliteFactory(),
    databasePath: args.databasePath,
  });

  try {
    const metadata = (await repository.list()).find((candidate) => {
      return candidate.id === args.sessionId;
    });
    const session = metadata
      ? await repository.open(metadata)
      : await repository.create({
          id: args.sessionId,
          cwd: args.executionEnv.cwd,
        });
    const entries = await session.findEntriesOnBranch({
      type: "message",
      order: "oldestFirst",
    });
    const previousMessages = entries.map((entry) => {
      if (entry.type !== "message") {
        throw new Error("Pi session returned a non-message entry");
      }
      return entry.message;
    });
    const loopMessages = await runPiAgentPrompt(
      {
        model: args.model,
        systemPrompt: args.systemPrompt,
        prompt: args.prompt,
        messages: previousMessages,
        executionEnv: args.executionEnv,
        async onEvent(event: AgentEvent) {
          if (
            event.type !== "message_end" ||
            !isPersistedMessage(event.message)
          ) {
            return;
          }
          await session.appendMessage(canonicalDurableMessage(event.message));
          if (event.message.role === "assistant") {
            await args.onAssistantMessage?.(event.message);
          }
        },
      },
      signal,
    );
    const newMessages = loopMessages.filter(isPersistedMessage);
    return {
      messages: newMessages,
      finalAssistantMessage: finalAssistantMessage(newMessages),
    };
  } finally {
    await repository.close();
  }
}
