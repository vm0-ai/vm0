import { command, computed, state } from "ccstate";
import type { ClerkTokenSource } from "./clerk-token.ts";

interface ApiClientRuntimeBase {
  readonly apiBaseUrl: string;
  readonly oauthApiBaseUrl: string;
  readonly vercelProtectionBypass?: string;
  readonly onForceUpgrade?: () => void;
}

interface ApiClientRuntimeWithClerk extends ApiClientRuntimeBase {
  readonly clerk: Promise<ClerkTokenSource>;
  readonly environment: "app" | "worker";
}

export type ApiClientRuntime = ApiClientRuntimeWithClerk;

const internalApiClientRuntime$ = state<ApiClientRuntime | undefined>(
  undefined,
);

export const setApiClientRuntime$ = command(
  ({ set }, runtime: ApiClientRuntime): void => {
    set(internalApiClientRuntime$, runtime);
  },
);

export const apiClientRuntime$ = computed((get): ApiClientRuntime => {
  const runtime = get(internalApiClientRuntime$);
  if (!runtime) {
    throw new Error("API client runtime was not initialized");
  }
  return runtime;
});
