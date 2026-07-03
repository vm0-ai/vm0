import { command } from "ccstate";
import type {
  TestUsageStateActionBody,
  TestUsageStateActionResponse,
  TestUsageStateFixture,
  TestUsageStateInsightsResponse,
} from "@vm0/api-contracts/contracts/test-usage-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testUsageStateRoutes } from "../../test-usage-state";

const USAGE_STATE_ROUTE = "/api/test/usage-state";

export interface UsageFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly userIds: readonly string[];
}

interface SeedUsageFixtureArgs {
  readonly currentPeriodEnd?: Date | null;
  readonly tier?: string;
}

interface InsertUsageEventArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string | null;
  readonly kind?: string;
  readonly provider?: string;
  readonly category?: string;
  readonly quantity?: number;
  readonly creditsCharged?: number | null;
  readonly status?: string;
  readonly createdAt?: Date;
  readonly processedAt?: Date | null;
}

interface SeedUsagePricingArgs {
  readonly provider: string;
  readonly category: string;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface InsertModelUsageArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly creditsCharged?: number | null;
  readonly status?: string;
  readonly createdAt?: Date;
  readonly processedAt?: Date | null;
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly displayName?: string | null;
  readonly prompt?: string;
  readonly status?: string;
  readonly triggerSource?: string;
  readonly createdAt?: Date;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
}

interface SeedChatThreadRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly title?: string | null;
  readonly triggerSource?: string;
  readonly threadId?: string;
  readonly createdAt?: Date;
}

export interface InsightData {
  readonly agents: {
    readonly agentName: string;
    readonly agentId: string | null;
    readonly runs: number;
    readonly credits: number;
  }[];
  readonly creditsUsed: number;
  readonly creditBalance: number;
  readonly teamUsage: {
    readonly userId: string;
    readonly name: string;
    readonly credits: number;
    readonly agentNames: string[];
    readonly agentCredits: Record<string, number>;
  }[];
  readonly services: {
    readonly domain: string;
    readonly calls: number;
    readonly agentNames: string[];
  }[];
  readonly permissions: {
    readonly label: string;
    readonly connectorType: string;
    readonly allowed: number;
    readonly denied: number;
    readonly agentNames: string[];
  }[];
  readonly axiomDegraded?: boolean;
}

function requestUsageState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testUsageStateRoutes,
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

function fixtureFromWire(fixture: TestUsageStateFixture): UsageFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
    userIds: fixture.user_ids,
  };
}

function fixtureToWire(fixture: UsageFixture): TestUsageStateFixture {
  return {
    org_id: fixture.orgId,
    user_id: fixture.userId,
    user_ids: [...fixture.userIds],
  };
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

async function postAction(
  signal: AbortSignal,
  body: TestUsageStateActionBody,
): Promise<TestUsageStateActionResponse> {
  const response = await requestUsageState(
    signal,
    `${USAGE_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expectOk(response, `usage action ${body.action}`);
  return await readJson<TestUsageStateActionResponse>(response);
}

export const seedUsageFixture$ = command(
  async (
    _,
    args: SeedUsageFixtureArgs,
    signal: AbortSignal,
  ): Promise<UsageFixture> => {
    const response = await postAction(signal, {
      action: "seed-fixture",
      current_period_end: dateToWire(args.currentPeriodEnd),
      tier: args.tier,
    });
    if (!response.fixture) {
      throw new Error("seedUsageFixture$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteUsageFixture$ = command(
  async (_, fixture: UsageFixture, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "delete-fixture",
      fixture: fixtureToWire(fixture),
    });
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
      credits_charged: args.creditsCharged,
      status: args.status,
      created_at: dateToWire(args.createdAt) ?? undefined,
      processed_at: dateToWire(args.processedAt),
    });
    if (!response.usage_event_id) {
      throw new Error("insertUsageEvent$: response missing usage_event_id");
    }
    return response.usage_event_id;
  },
);

export const seedUsagePricing$ = command(
  async (_, args: SeedUsagePricingArgs, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "seed-usage-pricing",
      provider: args.provider,
      category: args.category,
      unit_price: args.unitPrice,
      unit_size: args.unitSize,
    });
  },
);

export const emitRunUsageMessage$ = command(
  async (_, runId: string, signal: AbortSignal): Promise<boolean> => {
    const response = await postAction(signal, {
      action: "emit-run-usage-message",
      run_id: runId,
    });
    return response.emitted ?? false;
  },
);

export const insertModelUsage$ = command(
  async (_, args: InsertModelUsageArgs, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "insert-model-usage",
      org_id: args.orgId,
      user_id: args.userId,
      run_id: args.runId,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cache_read_input_tokens: args.cacheReadInputTokens,
      cache_creation_input_tokens: args.cacheCreationInputTokens,
      credits_charged: args.creditsCharged,
      status: args.status,
      created_at: dateToWire(args.createdAt) ?? undefined,
      processed_at: dateToWire(args.processedAt),
    });
  },
);

export const seedRun$ = command(
  async (
    _,
    args: SeedRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string; composeId: string }> => {
    const response = await postAction(signal, {
      action: "seed-run",
      org_id: args.orgId,
      user_id: args.userId,
      display_name: args.displayName,
      prompt: args.prompt,
      status: args.status,
      trigger_source: args.triggerSource,
      created_at: dateToWire(args.createdAt) ?? undefined,
      started_at: dateToWire(args.startedAt),
      completed_at: dateToWire(args.completedAt),
    });
    if (!response.run_id || !response.compose_id) {
      throw new Error("seedRun$: response missing run identifiers");
    }
    return { runId: response.run_id, composeId: response.compose_id };
  },
);

export const seedChatThreadRun$ = command(
  async (
    _,
    args: SeedChatThreadRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string; threadId: string; composeId: string }> => {
    const response = await postAction(signal, {
      action: "seed-chat-thread-run",
      org_id: args.orgId,
      user_id: args.userId,
      title: args.title,
      trigger_source: args.triggerSource,
      thread_id: args.threadId,
      created_at: dateToWire(args.createdAt) ?? undefined,
    });
    if (!response.run_id || !response.thread_id || !response.compose_id) {
      throw new Error("seedChatThreadRun$: response missing run identifiers");
    }
    return {
      runId: response.run_id,
      threadId: response.thread_id,
      composeId: response.compose_id,
    };
  },
);

export const setUsageFixtureCreditBalance$ = command(
  async (
    _,
    args: { readonly fixture: UsageFixture; readonly credits: number },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "set-credit-balance",
      org_id: args.fixture.orgId,
      credits: args.credits,
    });
  },
);

export const setUsageOrgTier$ = command(
  async (
    _,
    args: { readonly orgId: string; readonly tier: string },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "set-org-tier",
      org_id: args.orgId,
      tier: args.tier,
    });
  },
);

export const seedUsageUserName$ = command(
  async (
    _,
    args: {
      readonly userId: string;
      readonly email: string;
      readonly name: string | null;
      readonly cachedAt: Date;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-user-name",
      user_id: args.userId,
      email: args.email,
      name: args.name,
      cached_at: args.cachedAt.toISOString(),
    });
  },
);

export const seedUsageCachedOrgMember$ = command(
  async (
    _,
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly cachedAt: Date;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-cached-org-member",
      org_id: args.orgId,
      user_id: args.userId,
      cached_at: args.cachedAt.toISOString(),
    });
  },
);

export const seedExistingUsageInsights$ = command(
  async (
    _,
    args: {
      readonly fixture: UsageFixture;
      readonly date: string;
      readonly updatedAt: Date;
      readonly data?: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-existing-insights",
      org_id: args.fixture.orgId,
      user_id: args.fixture.userId,
      date: args.date,
      updated_at: args.updatedAt.toISOString(),
      data: args.data,
    });
  },
);

export const findUsageInsights$ = command(
  async (
    _,
    args: { readonly fixture: UsageFixture; readonly date: string },
    signal: AbortSignal,
  ): Promise<InsightData | null> => {
    const query = new URLSearchParams({
      org_id: args.fixture.orgId,
      user_id: args.fixture.userId,
      date: args.date,
    });
    const response = await requestUsageState(
      signal,
      `${USAGE_STATE_ROUTE}/insights?${query.toString()}`,
    );
    signal.throwIfAborted();
    expectOk(response, "findUsageInsights$");
    signal.throwIfAborted();
    const body = await readJson<TestUsageStateInsightsResponse>(response);
    signal.throwIfAborted();
    return (body.data as InsightData | null | undefined) ?? null;
  },
);
