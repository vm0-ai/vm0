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
      const initialToken = await options.getToken(signal);
      const path = options.resolvePath
        ? await options.resolvePath(args.path, { method: args.route.method })
        : args.path;

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

      const measurement = startClientTelemetryMeasurement();
      const requestTelemetry = {
        event_name: "http.request",
        method: args.route.method,
        route: args.route.path,
      } satisfies ClientTelemetryOperation;
      const response = await onRejection(
        requestWithToken(initialToken, signal),
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
          response_status_code: response.status,
        },
        response.status >= 500 ? "error" : "success",
      );

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
