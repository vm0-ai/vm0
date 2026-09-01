import { command, computed, state } from "ccstate";
import type { ClerkTokenSource } from "./clerk-token.ts";

interface ApiClientRuntimeBase {
  readonly apiBaseUrl: string;
  readonly oauthApiBaseUrl: string;
  readonly vercelProtectionBypass?: string;
  readonly onForceUpgrade?: () => void;
}

interface AppApiClientRuntime extends ApiClientRuntimeBase {
  readonly clerk: Promise<ClerkTokenSource>;
  readonly environment: "app";
}

interface WorkerApiClientRuntime extends ApiClientRuntimeBase {
  readonly environment: "worker";
  readonly getToken: (signal: AbortSignal) => Promise<string | null>;
  readonly reloadToken: (signal: AbortSignal) => Promise<string | null>;
}

export type ApiClientRuntime = AppApiClientRuntime | WorkerApiClientRuntime;

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
