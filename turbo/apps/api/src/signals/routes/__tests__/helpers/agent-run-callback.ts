import { command } from "ccstate";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";

import { writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "./encrypt-secret";

interface SeedAgentRunCallbackOptions {
  readonly runId: string;
  readonly url: string;
  readonly payload: Record<string, unknown>;
  readonly secret?: string;
  readonly status?: "pending" | "delivered" | "failed";
}

export const seedAgentRunCallback$ = command(
  async (
    { set },
    options: SeedAgentRunCallbackOptions,
    signal: AbortSignal,
  ): Promise<{ readonly callbackId: string }> => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .insert(agentRunCallbacks)
      .values({
        runId: options.runId,
        url: options.url,
        encryptedSecret: encryptSecretForTests(
          options.secret ?? "test-callback-secret",
        ),
        payload: options.payload,
        status: options.status ?? "pending",
      })
      .returning({ id: agentRunCallbacks.id });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("seedAgentRunCallback$: insert returned no row");
    }
    return { callbackId: row.id };
  },
);
