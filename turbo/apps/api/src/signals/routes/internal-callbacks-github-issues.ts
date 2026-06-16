import { command } from "ccstate";
import { internalCallbacksGithubIssuesContract } from "@vm0/api-contracts/contracts/internal-callbacks-github-issues";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { handleGithubIssuesInternalCallback$ } from "../services/internal-github-issues-run-callback.service";

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 404 | 500,
  message: string,
): {
  readonly status: 400 | 404 | 500;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

const handleGithubIssuesCallbackRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await set(
      handleGithubIssuesInternalCallback$,
      get(callbackPayload$),
      signal,
    );
    return result.success
      ? successResponse()
      : errorResponse(result.status, result.error);
  },
);

export const internalCallbacksGithubIssuesRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksGithubIssuesContract.post,
    handler: callbackRoute(handleGithubIssuesCallbackRoute$),
  },
];
