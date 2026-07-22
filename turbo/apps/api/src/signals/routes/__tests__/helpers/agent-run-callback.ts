import { command } from "ccstate";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testTelegramStateRoutes } from "../../test-telegram-state";

const TELEGRAM_STATE_ACTION_ROUTE = "/api/test/telegram-state/action";

interface SeedAgentRunCallbackOptions {
  readonly runId: string;
  readonly url?: string;
  readonly internalKind?: string;
  readonly payload: Record<string, unknown>;
  readonly secret?: string;
  readonly status?: "pending" | "delivered" | "failed";
}

interface AgentRunCallbackSnapshot {
  readonly id: string;
  readonly internalKind: string | null;
  readonly payload: unknown;
  readonly status: "pending" | "delivered" | "failed";
  readonly attempts: number;
  readonly lastError: string | null;
}

interface ReadAgentRunCallbacksOptions {
  readonly orgId: string;
  readonly userId: string;
  readonly prompt: string;
}

function requestTelegramState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testTelegramStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

function agentRunCallbackSnapshot(
  value: unknown,
): AgentRunCallbackSnapshot | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = "id" in value && typeof value.id === "string" ? value.id : null;
  const internalKind =
    "internalKind" in value &&
    (typeof value.internalKind === "string" || value.internalKind === null)
      ? value.internalKind
      : null;
  const status =
    "status" in value &&
    (value.status === "pending" ||
      value.status === "delivered" ||
      value.status === "failed")
      ? value.status
      : null;
  if (!id || !status) {
    return null;
  }
  return {
    id,
    internalKind,
    payload: "payload" in value ? value.payload : undefined,
    status,
    attempts:
      "attempts" in value && typeof value.attempts === "number"
        ? value.attempts
        : 0,
    lastError:
      "lastError" in value &&
      (typeof value.lastError === "string" || value.lastError === null)
        ? value.lastError
        : null,
  };
}

export const seedAgentRunCallback$ = command(
  async (
    _,
    options: SeedAgentRunCallbackOptions,
    signal: AbortSignal,
  ): Promise<{ readonly callbackId: string }> => {
    const response = await requestTelegramState(
      signal,
      TELEGRAM_STATE_ACTION_ROUTE,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "seed-agent-run-callback",
          run_id: options.runId,
          url: options.url ?? null,
          internal_kind: options.internalKind ?? null,
          payload: options.payload,
          secret: options.secret,
          status: options.status,
        }),
      },
    );
    signal.throwIfAborted();
    expectOk(response, "seedAgentRunCallback$");
    signal.throwIfAborted();
    const body = await readJson<Record<string, unknown>>(response);
    signal.throwIfAborted();
    const callbackId =
      typeof body.callback_id === "string" ? body.callback_id : null;
    if (!callbackId) {
      throw new Error("seedAgentRunCallback$: response missing callback_id");
    }
    return { callbackId };
  },
);

export const readAgentRunCallbacks$ = command(
  async (
    _,
    options: ReadAgentRunCallbacksOptions,
    signal: AbortSignal,
  ): Promise<readonly AgentRunCallbackSnapshot[]> => {
    const response = await requestTelegramState(
      signal,
      TELEGRAM_STATE_ACTION_ROUTE,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "get-post-run-state",
          org_id: options.orgId,
          user_id: options.userId,
          prompt: options.prompt,
        }),
      },
    );
    signal.throwIfAborted();
    expectOk(response, "readAgentRunCallbacks$");
    signal.throwIfAborted();
    const body = await readJson<Record<string, unknown>>(response);
    signal.throwIfAborted();
    if (!Array.isArray(body.callbacks)) {
      return [];
    }
    return body.callbacks.flatMap((value) => {
      const callback = agentRunCallbackSnapshot(value);
      return callback ? [callback] : [];
    });
  },
);
