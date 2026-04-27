import {
  initClient,
  type ApiFetcher,
  type ApiFetcherArgs,
  type AppRouter,
  type InitClientArgs,
  type InitClientReturn,
} from "@ts-rest/core";
import { afterEach, expect } from "vitest";

import { createApp } from "../app-factory";
import { clearMockedEnv } from "../lib/env";
import { ROUTES, type RouteDefinition } from "../signals/route";
import { clearAllDetached } from "../signals/utils";
import { getApiTestMocks, type ApiTestMocks } from "./mocks";

interface TestContext {
  readonly signal: AbortSignal;
  readonly mocks: ApiTestMocks;
}

interface SetupAppOptions<TContract extends AppRouter> {
  readonly context: TestContext;
  readonly contract: TContract;
  readonly routesExtend?: ReadonlyArray<RouteDefinition<unknown>>;
}

function formatBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  return JSON.stringify(body) ?? String(body);
}

export async function accept<
  TResponse extends { status: number; body: unknown },
  TStatus extends TResponse["status"] & number,
>(
  promise: Promise<TResponse>,
  statuses: readonly TStatus[],
): Promise<Extract<TResponse, { status: TStatus }>> {
  const result = await promise;
  if (!(statuses as readonly number[]).includes(result.status)) {
    expect(
      statuses,
      `Expected API response status to be one of ${statuses.join(
        ", ",
      )}, received ${result.status}. Body: ${formatBody(result.body)}`,
    ).toContain(result.status as TStatus);
  }

  return result as Extract<TResponse, { status: TStatus }>;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  if (contentType.startsWith("text/")) {
    return response.text();
  }

  return response.blob();
}

async function requestApp(
  app: ReturnType<typeof createApp>,
  args: ApiFetcherArgs,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await app.request(args.path, {
    ...args.fetchOptions,
    method: args.method,
    headers: args.headers,
    body: args.body,
  });

  return {
    status: response.status,
    body: await parseResponseBody(response),
    headers: response.headers,
  };
}

function createAppFetcher(
  context: TestContext,
  routesExtend: ReadonlyArray<RouteDefinition<unknown>>,
): ApiFetcher {
  const app = createApp({
    signal: context.signal,
    routes: [...ROUTES, ...routesExtend],
  });

  return (args) => {
    return requestApp(app, args);
  };
}

export function setupApp<TContract extends AppRouter>({
  context,
  contract,
  routesExtend = [],
}: SetupAppOptions<TContract>): InitClientReturn<TContract, InitClientArgs> {
  return initClient(contract, {
    baseUrl: "http://api.test",
    jsonQuery: false,
    throwOnUnknownStatus: true,
    validateResponse: false,
    api: createAppFetcher(context, routesExtend),
  });
}

export function testContext(): TestContext {
  let controller = new AbortController();

  const context: TestContext = {
    get signal(): AbortSignal {
      return controller.signal;
    },
    mocks: getApiTestMocks(),
  };

  afterEach(async () => {
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);
    controller = new AbortController();

    await clearAllDetached();
    clearMockedEnv();
  });

  return context;
}
