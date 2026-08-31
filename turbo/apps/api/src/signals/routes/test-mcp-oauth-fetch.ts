import {
  testMcpOAuthFetchContract,
  type TestMcpOAuthFetchRequest,
} from "@okouai/api-contracts/contracts/test-mcp-oauth-fetch";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { mcpOAuthSafeFetch } from "../services/mcp-oauth-safe-fetch.service";
import { settleIncludingAbort } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

function probeBody(
  input: TestMcpOAuthFetchRequest,
): string | URLSearchParams | undefined {
  if (input.bodyKind === "form") {
    return new URLSearchParams(input.body ?? "");
  }
  if (input.bodyKind === "json") {
    return input.body ?? "";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown MCP OAuth error";
}

const probeRequestBody$ = bodyResultOf(testMcpOAuthFetchContract.request);
const probeRequest$ = command(async ({ get }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(probeRequestBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const caller = new AbortController();
  if (bodyResult.data.cancel) {
    caller.abort();
  }
  const requestSignal = AbortSignal.any([signal, caller.signal]);
  const result = await settleIncludingAbort(
    mcpOAuthSafeFetch(bodyResult.data.url, {
      method: bodyResult.data.method,
      headers: {
        ...(bodyResult.data.authorization
          ? { authorization: bodyResult.data.authorization }
          : {}),
        ...(bodyResult.data.bodyKind === "json"
          ? { "content-type": "application/json" }
          : {}),
      },
      body: probeBody(bodyResult.data),
      signal: requestSignal,
    }),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return {
      status: 502 as const,
      body: { error: errorMessage(result.error) },
    };
  }
  const responseBody = await result.value.text();
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      status: result.value.status,
      headers: Object.fromEntries(result.value.headers),
      body: responseBody,
    },
  };
});

export const testMcpOAuthFetchRoutes: readonly RouteEntry[] = [
  {
    route: testMcpOAuthFetchContract.request,
    handler: probeRequest$,
  },
];
