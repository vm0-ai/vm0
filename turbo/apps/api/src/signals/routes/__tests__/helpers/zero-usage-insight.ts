import { command } from "ccstate";
import type {
  TestUsageInsightStateActionBody,
  TestUsageInsightStateActionResponse,
  TestUsageInsightStateFixture,
} from "@vm0/api-contracts/contracts/test-usage-insight-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testUsageInsightStateRoutes } from "../../test-usage-insight-state";

const USAGE_INSIGHT_STATE_ROUTE = "/api/test/usage-insight-state";

export interface UsageInsightFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface ComposeResult {
  readonly composeId: string;
  readonly agentId: string;
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly triggerSource?: string;
  readonly automationId?: string;
  readonly chatThreadId?: string;
  readonly status?: string;
  readonly prompt?: string;
  readonly createdAt?: Date;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly continuedFromSessionId?: string | null;
  readonly sandboxReuseResult?: string | null;
  readonly result?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly lastEventSequence?: number | null;
  readonly selectedModel?: string | null;
}

interface SeedAutomationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly name?: string;
  readonly description?: string;
}

interface SeedChatThreadArgs {
  readonly userId: string;
  readonly composeId: string;
  readonly title?: string;
}

interface ModelUsageEventArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly creditsCharged?: number;
  readonly status?: string;
  readonly processedAt?: Date | null;
}

interface InsertUsageEventArgs {
  readonly orgId: string;
  readonly userId?: string;
  readonly runId?: string | null;
  readonly kind?: string;
  readonly provider?: string;
  readonly category?: string;
  readonly quantity?: number;
  readonly status?: string;
  readonly creditsCharged?: number;
  readonly idempotencyKey?: string;
  readonly createdAt?: Date;
  readonly processedAt?: Date | null;
}

interface BonusUsageEvent {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly creditsCharged: number;
  readonly status: string;
}

interface AutomationBatchArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly count: number;
  readonly creditsForIndex: (index: number) => number;
  readonly bonusUsageEventForIndex?: (index: number) => BonusUsageEvent | null;
}

function requestUsageInsightState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testUsageInsightStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

function dateToWire(value: Date | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return value.toISOString();
}

function fixtureFromWire(
  fixture: TestUsageInsightStateFixture,
): UsageInsightFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
  };
}

function fixtureToWire(
  fixture: UsageInsightFixture,
): TestUsageInsightStateFixture {
  return {
    org_id: fixture.orgId,
    user_id: fixture.userId,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestUsageInsightStateActionBody,
): Promise<TestUsageInsightStateActionResponse> {
  const response = await requestUsageInsightState(
    signal,
    `${USAGE_INSIGHT_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  signal.throwIfAborted();
  await expectOk(response, `usage insight action ${body.action}`);
  signal.throwIfAborted();
  const result = await readJson<TestUsageInsightStateActionResponse>(response);
  signal.throwIfAborted();
  return result;
}

export const seedUsageInsightFixture$ = command(
  async (
    _,
    _input: void,
    signal: AbortSignal,
  ): Promise<UsageInsightFixture> => {
    const response = await postAction(signal, { action: "seed-fixture" });
    if (!response.fixture) {
      throw new Error("seedUsageInsightFixture$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteUsageInsightFixture$ = command(
  async (
    _,
    fixture: UsageInsightFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-fixture",
      fixture: fixtureToWire(fixture),
    });
  },
);

export const seedCompose$ = command(
  async (
    _,
    args: {
      orgId: string;
      userId: string;
      name?: string;
      displayName?: string | null;
      visibility?: "public" | "private";
    },
    signal: AbortSignal,
  ): Promise<ComposeResult> => {
    const response = await postAction(signal, {
      action: "seed-compose",
      org_id: args.orgId,
      user_id: args.userId,
      name: args.name,
      display_name: args.displayName,
      visibility: args.visibility,
    });
    if (!response.compose_id || !response.agent_id) {
      throw new Error("seedCompose$: response missing compose identifiers");
    }
    return {
      composeId: response.compose_id,
      agentId: response.agent_id,
    };
  },
);

export const seedRun$ = command(
  async (
    _,
    args: SeedRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string }> => {
    const response = await postAction(signal, {
      action: "seed-run",
      org_id: args.orgId,
      user_id: args.userId,
      compose_id: args.composeId,
      trigger_source: args.triggerSource,
      automation_id: args.automationId,
      chat_thread_id: args.chatThreadId,
      status: args.status,
      prompt: args.prompt,
      created_at: dateToWire(args.createdAt) ?? undefined,
      started_at: dateToWire(args.startedAt),
      completed_at: dateToWire(args.completedAt),
      continued_from_session_id: args.continuedFromSessionId,
      sandbox_reuse_result: args.sandboxReuseResult,
      result: args.result,
      error: args.error,
      last_event_sequence: args.lastEventSequence,
      selected_model: args.selectedModel,
    });
    if (!response.run_id) {
      throw new Error("seedRun$: response missing run_id");
    }
    return { runId: response.run_id };
  },
);

export const seedAutomation$ = command(
  async (_, args: SeedAutomationArgs, signal: AbortSignal): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-automation",
      org_id: args.orgId,
      user_id: args.userId,
      agent_id: args.agentId,
      name: args.name,
      description: args.description,
    });
    if (!response.automation_id) {
      throw new Error("seedAutomation$: response missing automation_id");
    }
    return response.automation_id;
  },
);

export const seedChatThread$ = command(
  async (_, args: SeedChatThreadArgs, signal: AbortSignal): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-chat-thread",
      user_id: args.userId,
      compose_id: args.composeId,
      title: args.title,
    });
    if (!response.chat_thread_id) {
      throw new Error("seedChatThread$: response missing chat_thread_id");
    }
    return response.chat_thread_id;
  },
);

export const insertModelUsageEventForRun$ = command(
  async (
    _,
    args: ModelUsageEventArgs,
    signal: AbortSignal,
  ): Promise<{ id: string }> => {
    const response = await postAction(signal, {
      action: "insert-model-usage-event-for-run",
      org_id: args.orgId,
      user_id: args.userId,
      run_id: args.runId,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cache_read_input_tokens: args.cacheReadInputTokens,
      cache_creation_input_tokens: args.cacheCreationInputTokens,
      credits_charged: args.creditsCharged,
      status: args.status,
      processed_at: dateToWire(args.processedAt),
    });
    if (!response.usage_event_id) {
      throw new Error(
        "insertModelUsageEventForRun$: response missing usage_event_id",
      );
    }
    return { id: response.usage_event_id };
  },
);

export const insertUsageEvent$ = command(
  async (
    _,
    args: InsertUsageEventArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "insert-usage-event",
      org_id: args.orgId,
      user_id: args.userId,
      run_id: args.runId,
      kind: args.kind,
      provider: args.provider,
      category: args.category,
      quantity: args.quantity,
      status: args.status,
      credits_charged: args.creditsCharged,
      idempotency_key: args.idempotencyKey,
      created_at: dateToWire(args.createdAt) ?? undefined,
      processed_at: dateToWire(args.processedAt),
    });
    if (!response.usage_event_id) {
      throw new Error("insertUsageEvent$: response missing usage_event_id");
    }
    return response.usage_event_id;
  },
);

export const setUsageEventCreatedAt$ = command(
  async (
    _,
    args: { id: string; createdAt: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "set-usage-event-created-at",
      id: args.id,
      created_at: args.createdAt.toISOString(),
    });
  },
);

export const seedAutomationBatch$ = command(
  async (
    _,
    args: AutomationBatchArgs,
    signal: AbortSignal,
  ): Promise<{ automationIds: string[] }> => {
    const entries = Array.from({ length: args.count }, (_, index) => {
      const bonus = args.bonusUsageEventForIndex?.(index);
      return {
        credits: args.creditsForIndex(index),
        bonus: bonus
          ? {
              kind: bonus.kind,
              provider: bonus.provider,
              category: bonus.category,
              quantity: bonus.quantity,
              credits_charged: bonus.creditsCharged,
              status: bonus.status,
            }
          : null,
      };
    });
    const response = await postAction(signal, {
      action: "seed-automation-batch",
      org_id: args.orgId,
      user_id: args.userId,
      compose_id: args.composeId,
      entries,
    });
    if (!response.automation_ids) {
      throw new Error("seedAutomationBatch$: response missing automation_ids");
    }
    return { automationIds: response.automation_ids };
  },
);
