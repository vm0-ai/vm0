import { command } from "ccstate";
import type {
  TestUsageStateActionBody,
  TestUsageStateActionResponse,
} from "@vm0/api-contracts/contracts/test-usage-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testUsageStateRoutes } from "../../test-usage-state";

const USAGE_STATE_ROUTE = "/api/test/usage-state";

interface SeedUsagePricingArgs {
  readonly kind?: string;
  readonly provider: string;
  readonly category: string;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface UsageFixtureCreditBalanceArgs {
  readonly fixture: {
    readonly orgId: string;
  };
  readonly credits: number;
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

export const seedUsagePricing$ = command(
  async (_, args: SeedUsagePricingArgs, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "seed-usage-pricing",
      kind: args.kind,
      provider: args.provider,
      category: args.category,
      unit_price: args.unitPrice,
      unit_size: args.unitSize,
    });
  },
);

export const setUsageFixtureCreditBalance$ = command(
  async (
    _,
    args: UsageFixtureCreditBalanceArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "set-credit-balance",
      org_id: args.fixture.orgId,
      credits: args.credits,
    });
  },
);
