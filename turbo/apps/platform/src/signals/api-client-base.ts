import {
  initClient,
  trpcRestFetchApi,
  validateResponse,
  type AppRouter,
  type ApiFetcherArgs,
  type InitClientArgs,
  type InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";

import { IN_VITEST } from "../env.ts";
import {
  clientTelemetryOutcomeForError,
  type ClientTelemetryOperation,
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../lib/client-telemetry.ts";
import { addClientHeaders } from "./client-headers.ts";
import { reportForceUpgradeResponse } from "./force-upgrade.ts";
import { onRejection } from "./utils.ts";

interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly clientVersion: string;
  readonly getRootSignal: () => AbortSignal;
  readonly getToken: (signal: AbortSignal) => Promise<string | null>;
  readonly getVercelProtectionBypass: () => string | undefined;
  readonly onForceUpgrade?: () => void;
  readonly validateResponse?: boolean;
  readonly resolvePath?: (
    path: string,
    ctx: { method: string },
  ) => Promise<string> | string;
}

// The app Worker that injects this script deploys independently from the app
// bundle that reads it, so the selector also accepts the pre-rename spelling.
// Drop the legacy half once every deployed Worker emits `data-okou-api-bootstrap`,
// which the Worker release carrying this change establishes.
const API_BOOTSTRAP_SELECTOR =
  'script[type="application/json"][data-okou-api-bootstrap],script[type="application/json"][data-vm0-api-bootstrap]';

function takeBootstrapResponse(
  method: string,
  requestUrl: string,
  baseUrl: string,
): {
  readonly status: 200;
  readonly body: unknown;
  readonly headers: Headers;
} | null {
  const currentDocument = globalThis.document;
  if (currentDocument === undefined) {
    return null;
  }

  const url = new URL(requestUrl, baseUrl);
  const path = `${url.pathname}${url.search}`;
  for (const script of currentDocument.querySelectorAll<HTMLScriptElement>(
    API_BOOTSTRAP_SELECTOR,
  )) {
    if (
      script.dataset.method !== method ||
      script.dataset.path !== encodeURIComponent(path) ||
      script.dataset.contentType !== "application/json"
    ) {
      continue;
    }

    // The Worker emits this inert script from a response already validated by
    // the bootstrap contract. Parsing here makes it the first API response.
    const body: unknown = JSON.parse(script.textContent ?? "");
    const headers = new Headers({
      "Content-Type": script.dataset.contentType,
    });
    script.remove();
    return { status: 200, body, headers };
  }

  return null;
}

export function createAuthedContractClient<T extends AppRouter>(
  contract: T,
  options: AuthedClientOptions,
): InitClientReturn<T, InitClientArgs> {
  return initClient(contract, {
    baseUrl: options.baseUrl,
    jsonQuery: false,
    // Validation is handled below so errors include the actual response body.
    validateResponse: false,
    api: async (args: ApiFetcherArgs) => {
      const signal = args.fetchOptions?.signal ?? options.getRootSignal();
      const path = options.resolvePath
        ? await options.resolvePath(args.path, { method: args.route.method })
        : args.path;
      signal.throwIfAborted();

      const requestWithToken = (
        token: string | null,
        requestSignal: AbortSignal,
      ) => {
        const headers = new Headers(args.headers);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        addClientHeaders(headers, options.clientVersion);
        const vercelProtectionBypass = options.getVercelProtectionBypass();
        if (vercelProtectionBypass) {
          headers.set("X-Vercel-Protection-Bypass", vercelProtectionBypass);
        }
        return trpcRestFetchApi({
          ...args,
          fetchOptions: {
            ...args.fetchOptions,
            credentials: "include",
            signal: requestSignal,
          },
          headers,
          path,
        });
      };

      const bootstrapResponse = takeBootstrapResponse(
        args.method,
        path,
        options.baseUrl,
      );
      const response =
        bootstrapResponse ??
        (await (async () => {
          const token = await options.getToken(signal);
          const measurement = startClientTelemetryMeasurement();
          const requestTelemetry = {
            event_name: "http.request",
            method: args.route.method,
            route: args.route.path,
          } satisfies ClientTelemetryOperation;
          const networkResponse = await onRejection(
            requestWithToken(token, signal),
            (error) => {
              recordClientTelemetry(
                measurement,
                requestTelemetry,
                clientTelemetryOutcomeForError(error),
              );
            },
          );
          recordClientTelemetry(
            measurement,
            {
              ...requestTelemetry,
              response_status_code: networkResponse.status,
            },
            networkResponse.status >= 500 ? "error" : "success",
          );
          return networkResponse;
        })());

      if (reportForceUpgradeResponse(response, options.onForceUpgrade)) {
        return response;
      }

      if (IN_VITEST || options.validateResponse) {
        return validateResponse({
          appRoute: args.route,
          response,
        });
      }

      return response;
    },
  });
}
