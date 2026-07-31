import type {
  TestModelStatsStateActionBody,
  TestModelStatsStateActionResponse,
} from "@vm0/api-contracts/contracts/test-model-stats-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testModelStatsStateRoutes } from "../../test-model-stats-state";

const MODEL_STATS_STATE_ROUTE = "/api/test/model-stats-state";

interface ModelStatsObservationState {
  readonly idempotencyKey: string;
  readonly aggregatedAt: string | null;
}

function requestModelStatsState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
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
): Promise<TestModelStatsStateActionResponse> {
  const response = await requestModelStatsState(
    context,
    `${MODEL_STATS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `model stats state action ${body.action}`);
  return await readJson<TestModelStatsStateActionResponse>(response);
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

export async function insertZeroTokenModelStatsObservation(
  context: TestContext,
  args: {
    readonly idempotencyKey: string;
    readonly model: string;
    readonly observedAt: Date;
  },
): Promise<void> {
  await postAction(context, {
    action: "insert-zero-token-observation",
    idempotency_key: args.idempotencyKey,
    model: args.model,
    observed_at: args.observedAt.toISOString(),
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
    readonly models: readonly string[];
    readonly windowStart: Date;
    readonly windowEnd: Date;
  },
): Promise<void> {
  await postAction(context, {
    action: "delete-fixture",
    idempotency_keys: [...args.idempotencyKeys],
    models: [...args.models],
    window_start: args.windowStart.toISOString(),
    window_end: args.windowEnd.toISOString(),
  });
}
