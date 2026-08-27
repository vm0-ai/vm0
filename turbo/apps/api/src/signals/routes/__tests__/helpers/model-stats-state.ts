import type {
  TestModelStatsStateActionBody,
  TestModelStatsStateActionResponse,
} from "@okouai/api-contracts/contracts/test-model-stats-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testModelStatsStateRoutes } from "../../test-model-stats-state";

const MODEL_STATS_STATE_ROUTE = "/api/test/model-stats-state";

interface ModelStatsObservationState {
  readonly idempotencyKey: string;
  readonly aggregatedAt: string | null;
}

export interface ModelStatsStatKey {
  readonly hourStart: Date;
  readonly model: string;
}

export interface ModelStatsFixtureScope {
  readonly observationIdempotencyKeys: readonly string[];
  readonly statKeys: readonly ModelStatsStatKey[];
}

interface ModelStatsAggregationFixtureOptions extends ModelStatsFixtureScope {
  readonly processedAt: Date;
  readonly cleanupBatchSize?: number;
  readonly cleanupMaxBatches?: number;
}

export interface ModelStatsObservationFixture {
  readonly idempotencyKey: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly observedAt: Date;
  readonly aggregatedAt: Date | null;
}

interface ModelStatsAggregationResult {
  readonly cutoff: string;
  readonly processedHours: number;
  readonly processedObservations: number;
  readonly updatedStats: number;
  readonly deletedObservations: number;
}

interface ModelStatsRankingResult {
  readonly period: "today" | "week" | "month";
  readonly totalTokens: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly rows: readonly {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly previousTotalTokens: number;
  }[];
}

function requestModelStatsState(
  context: TestContext,
  path: string,
  init?: RequestInit,
  signal: AbortSignal = context.signal,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testModelStatsStateRoutes,
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

async function postAction(
  context: TestContext,
  body: TestModelStatsStateActionBody,
  signal: AbortSignal = context.signal,
): Promise<TestModelStatsStateActionResponse> {
  const response = await requestModelStatsState(
    context,
    `${MODEL_STATS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );
  await expectOk(response, `model stats state action ${body.action}`);
  return await readJson<TestModelStatsStateActionResponse>(response);
}

function wireStatKeys(statKeys: readonly ModelStatsStatKey[]) {
  return statKeys.map((statKey) => {
    return {
      hour_start: statKey.hourStart.toISOString(),
      model: statKey.model,
    };
  });
}

function aggregateFixtureBody(
  args: ModelStatsAggregationFixtureOptions,
): TestModelStatsStateActionBody {
  return {
    action: "aggregate-fixture",
    processed_at: args.processedAt.toISOString(),
    observation_idempotency_keys: [...args.observationIdempotencyKeys],
    stat_keys: wireStatKeys(args.statKeys),
    ...(args.cleanupBatchSize === undefined
      ? {}
      : { cleanup_batch_size: args.cleanupBatchSize }),
    ...(args.cleanupMaxBatches === undefined
      ? {}
      : { cleanup_max_batches: args.cleanupMaxBatches }),
  };
}

export function requestAggregateModelStatsFixture(
  context: TestContext,
  args: ModelStatsAggregationFixtureOptions,
  signal: AbortSignal = context.signal,
): Promise<Response> {
  return requestModelStatsState(
    context,
    `${MODEL_STATS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(aggregateFixtureBody(args)),
    },
    signal,
  );
}

export async function aggregateModelStatsFixture(
  context: TestContext,
  args: ModelStatsAggregationFixtureOptions,
): Promise<ModelStatsAggregationResult> {
  const response = await postAction(context, aggregateFixtureBody(args));
  if (!response.aggregation) {
    throw new Error("Model stats aggregation response is incomplete");
  }
  return {
    cutoff: response.aggregation.cutoff,
    processedHours: response.aggregation.processed_hours,
    processedObservations: response.aggregation.processed_observations,
    updatedStats: response.aggregation.updated_stats,
    deletedObservations: response.aggregation.deleted_observations,
  };
}

export async function readModelStatsFixtureRankings(
  context: TestContext,
  args: {
    readonly period?: string;
    readonly now: Date;
    readonly statKeys: readonly ModelStatsStatKey[];
  },
): Promise<ModelStatsRankingResult> {
  const response = await postAction(context, {
    action: "read-fixture-rankings",
    ...(args.period === undefined ? {} : { period: args.period }),
    now: args.now.toISOString(),
    stat_keys: wireStatKeys(args.statKeys),
  });
  if (!response.ranking) {
    throw new Error("Model stats ranking response is incomplete");
  }
  return {
    period: response.ranking.period,
    totalTokens: response.ranking.total_tokens,
    windowStart: response.ranking.window_start,
    windowEnd: response.ranking.window_end,
    rows: response.ranking.rows.map((row) => {
      return {
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        previousTotalTokens: row.previous_total_tokens,
      };
    }),
  };
}

export async function holdModelStatsAggregationLock(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "hold-aggregation-lock" });
}

export async function readModelStatsAggregationLockState(
  context: TestContext,
): Promise<{ readonly held: boolean; readonly waiterCount: number }> {
  const response = await postAction(context, {
    action: "read-aggregation-lock-state",
  });
  if (
    response.aggregation_lock_held === undefined ||
    response.aggregation_lock_waiter_count === undefined
  ) {
    throw new Error("Model stats lock state response is incomplete");
  }
  return {
    held: response.aggregation_lock_held,
    waiterCount: response.aggregation_lock_waiter_count,
  };
}

export async function releaseModelStatsAggregationLock(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "release-aggregation-lock" });
}

export async function holdModelStatsObservationLock(
  context: TestContext,
  idempotencyKey: string,
): Promise<void> {
  await postAction(context, {
    action: "hold-observation-lock",
    idempotency_key: idempotencyKey,
  });
}

export async function readModelStatsObservationLockState(
  context: TestContext,
): Promise<{ readonly held: boolean }> {
  const response = await postAction(context, {
    action: "read-observation-lock-state",
  });
  if (response.observation_lock_held === undefined) {
    throw new Error(
      "Model stats observation lock state response is incomplete",
    );
  }
  return { held: response.observation_lock_held };
}

export async function releaseModelStatsObservationLock(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "release-observation-lock" });
}

export async function readModelStatsObservations(
  context: TestContext,
  idempotencyKeys: readonly string[],
): Promise<readonly ModelStatsObservationState[]> {
  const response = await postAction(context, {
    action: "read-observations",
    idempotency_keys: [...idempotencyKeys],
  });
  if (!response.observations) {
    throw new Error("Model stats observation response is incomplete");
  }
  return response.observations.map((observation) => {
    return {
      idempotencyKey: observation.idempotency_key,
      aggregatedAt: observation.aggregated_at,
    };
  });
}

export async function insertModelStatsObservations(
  context: TestContext,
  observations: readonly ModelStatsObservationFixture[],
): Promise<void> {
  await postAction(context, {
    action: "insert-observations",
    observations: observations.map((observation) => {
      return {
        idempotency_key: observation.idempotencyKey,
        model: observation.model,
        input_tokens: observation.inputTokens,
        output_tokens: observation.outputTokens,
        cache_read_input_tokens: observation.cacheReadInputTokens,
        cache_creation_input_tokens: observation.cacheCreationInputTokens,
        observed_at: observation.observedAt.toISOString(),
        aggregated_at: observation.aggregatedAt?.toISOString() ?? null,
      };
    }),
  });
}

export async function insertAppliedModelStatsObservations(
  context: TestContext,
  args: {
    readonly idempotencyKeys: readonly string[];
    readonly model: string;
    readonly observedAt: Date;
    readonly aggregatedAt: Date;
  },
): Promise<void> {
  await postAction(context, {
    action: "insert-applied-observations",
    idempotency_keys: [...args.idempotencyKeys],
    model: args.model,
    observed_at: args.observedAt.toISOString(),
    aggregated_at: args.aggregatedAt.toISOString(),
  });
}

export async function deleteModelStatsObservations(
  context: TestContext,
  idempotencyKeys: readonly string[],
): Promise<void> {
  await postAction(context, {
    action: "delete-observations",
    idempotency_keys: [...idempotencyKeys],
  });
}

export async function deleteModelStatsFixture(
  context: TestContext,
  args: {
    readonly idempotencyKeys: readonly string[];
    readonly statKeys: readonly ModelStatsStatKey[];
  },
): Promise<void> {
  await postAction(context, {
    action: "delete-fixture",
    idempotency_keys: [...args.idempotencyKeys],
    stat_keys: wireStatKeys(args.statKeys),
  });
}
