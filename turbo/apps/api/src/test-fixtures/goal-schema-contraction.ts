import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Client } from "pg";
import { closeDbPool, db } from "../lib/db";
import { env, mockEnv, optionalEnv } from "../lib/env";
import { flushWaitUntilForTest } from "../signals/context/wait-until";
import { installApiTestConnectorCatalog } from "./connector-catalog";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { eq, and, lte } from "drizzle-orm";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { insertChatEvent } from "../signals/services/chat-event.service";

/** Contract only a test-owned database; never alter the shared suite database. */
export async function withContractedGoalSchema(
  work: (statements: () => readonly string[]) => Promise<void>,
): Promise<void> {
  const originalUrl = env("DATABASE_URL");
  const url = new URL(originalUrl);
  if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname)) {
    throw new Error("Schema contraction fixtures require local PostgreSQL");
  }
  const name = `goal_contraction_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: originalUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const run = async () => {
    await promisify(execFile)("pnpm", ["db:migrate"], {
      cwd: fileURLToPath(new URL("../../../../packages/db", import.meta.url)),
      env: {
        PATH: optionalEnv("PATH"),
        HOME: optionalEnv("HOME"),
        DATABASE_URL: url.toString(),
      },
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    const [contracted] = await Promise.allSettled([
      client.query(
        "ALTER TABLE agent_runs DROP COLUMN goal_id CASCADE; DROP TABLE thread_goals CASCADE;",
      ),
    ]);
    await client.end();
    if (contracted.status === "rejected") {
      throw contracted.reason;
    }
    await closeDbPool();
    mockEnv("DATABASE_URL", url.toString());
    trace.disable();
    trace.setGlobalTracerProvider(provider);
    await installApiTestConnectorCatalog();
    exporter.reset();
    await work(() => {
      return exporter.getFinishedSpans().flatMap((span) => {
        const statement = span.attributes["db.statement"];
        return typeof statement === "string" ? [statement] : [];
      });
    });
  };
  const [result] = await Promise.allSettled([run()]);
  await flushWaitUntilForTest();
  await closeDbPool();
  mockEnv("DATABASE_URL", originalUrl);
  trace.disable();
  await provider.shutdown();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  if (result.status === "rejected") {
    throw result.reason;
  }
}

/** A legacy terminal run retains canonical provenance without a Goal row. */
export async function seedRetainedRunProvenance(
  runId: string,
  threadId: string,
  groupId: string | null,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .update(agentRuns)
      .set({ triggerSource: "goal" })
      .where(eq(agentRuns.id, runId));
    if (groupId !== null) {
      await insertChatEvent(tx, {
        chatThreadId: threadId,
        runId,
        runGroupId: groupId,
        eventType: "output.message",
        content: "Retained historical output",
      });
    }
  });
}

export async function removeSnapshottedRunEvents(
  threadId: string,
): Promise<void> {
  const [head] = await db()
    .select({ lastSeqId: chatEventSnapshots.lastSeqId })
    .from(chatEventSnapshots)
    .where(eq(chatEventSnapshots.chatThreadId, threadId));
  if (!head) {
    throw new Error("Expected a published snapshot before removing hot rows");
  }
  await db()
    .delete(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        lte(chatEvents.seqId, head.lastSeqId),
      ),
    );
}

export async function retainedUsageRows(runId: string) {
  return await db()
    .select()
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        eq(chatEvents.eventType, "usage.recorded"),
      ),
    )
    .orderBy(chatEvents.seqId);
}
