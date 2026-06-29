import {
  initClient,
  type ApiFetcher,
  type ApiFetcherArgs,
  type AppRouter,
  type InitClientArgs,
  type InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";

import { createAppWithRoutes } from "../app-factory-core";
import type { RouteEntry } from "../signals/route-entry";
import type { TestContext } from "./test-context";

interface SetupAppWithRoutesOptions {
  readonly context: TestContext;
  readonly routes: readonly RouteEntry[];
}

function parseResponseBody(response: Response): Promise<unknown> | undefined {
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
  app: ReturnType<typeof createAppWithRoutes>,
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
  routes: readonly RouteEntry[],
): ApiFetcher {
  const app = createAppWithRoutes({ signal: context.signal, routes });

  return (args) => {
    return requestApp(app, args);
  };
}

export function setupAppWithRoutes({
  context,
  routes,
}: SetupAppWithRoutesOptions) {
  const app = createAppFetcher(context, routes);

  return <TContract extends AppRouter>(
    contract: TContract,
  ): InitClientReturn<TContract, InitClientArgs> => {
    return initClient(contract, {
      baseUrl: "http://api.test",
      jsonQuery: false,
      throwOnUnknownStatus: true,
      validateResponse: true,
      api: app,
    });
  };
}
