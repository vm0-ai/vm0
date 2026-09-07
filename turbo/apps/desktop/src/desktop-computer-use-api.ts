import { COMPUTER_USE_PLUGIN_CALL_KIND } from "@okouai/api-contracts/contracts/computer-use-plugins";
import type {
  ComputerUseCommand,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import type { ComputerUseDriverController } from "./computer-use-driver";
import {
  ComputerUseHostRuntime,
  type ComputerUseHostFetch,
} from "./computer-use-host";
import type { DesktopProduct } from "@okouai/api-contracts/contracts/client-headers";
import type { DesktopAuthSession } from "./desktop-auth-session";
import type { DesktopClientHeaderInjector } from "./desktop-client-headers";
import {
  headersWithSessionCookies,
  type DesktopSessionCookieSource,
} from "./desktop-session-cookies";

export function createDesktopComputerUseHostRuntime(
  options: Omit<
    ConstructorParameters<typeof ComputerUseHostRuntime>[0],
    "sessionFetch" | "acquireCommand"
  > & {
    readonly driver: ComputerUseDriverController;
    readonly executePluginCommand: (
      command: ComputerUseCommand,
    ) => Promise<ComputerUseCommandExecutionResult>;
  },
  auth: {
    readonly product: DesktopProduct;
    readonly session: DesktopSessionCookieSource;
    readonly getAuthSession: () => DesktopAuthSession;
  },
): ComputerUseHostRuntime {
  return new ComputerUseHostRuntime({
    ...options,
    acquireCommand: () => {
      // Pin before claim whenever native commands are advertised. Plugin-only
      // polling remains independent of native startup, permissions and cleanup.
      const native =
        options.driver.getCapabilities().length > 0
          ? options.driver.acquireCommand()
          : null;
      return {
        identity: native?.identity,
        beginCommand: (budget) => native?.beginCommand?.(budget),
        release: () => native?.release(),
        abort: () => native?.abort?.(),
        getPermissions: (command) =>
          command?.kind === COMPUTER_USE_PLUGIN_CALL_KIND || !native
            ? Promise.resolve({ accessibility: false, screenRecording: false })
            : native.getPermissions(command),
        executeCommand: (command, permissions) =>
          command.kind === COMPUTER_USE_PLUGIN_CALL_KIND
            ? options.executePluginCommand(command)
            : native
              ? native.executeCommand(command, permissions)
              : Promise.resolve({
                  status: "failed",
                  error: {
                    code: "accessibility_unavailable",
                    message:
                      "Native capabilities were withdrawn before claim; no action was dispatched",
                  },
                }),
      };
    },
    // Okou shares the App session's bearer, refresh and sign-out lifetime.
    // Zero keeps its existing Computer Use cookie and token retry policy.
    sessionFetch:
      auth.product === "okou"
        ? (input, init) =>
            auth.getAuthSession().fetchWithSessionAuth(new URL(input), init)
        : createDesktopComputerUseSessionFetch({
            platformUrl: options.platformUrl,
            session: auth.session,
            addClientHeaders: options.addClientHeaders,
            getCachedAuthToken: () => auth.getAuthSession().getCachedToken(),
            getAuthToken: (options) => auth.getAuthSession().getToken(options),
          }),
  });
}

export function createDesktopComputerUseSessionFetch(params: {
  readonly platformUrl: URL;
  readonly session: DesktopSessionCookieSource;
  readonly addClientHeaders: DesktopClientHeaderInjector;
  readonly getCachedAuthToken?: () => Promise<string | null> | string | null;
  readonly getAuthToken?: (options?: {
    readonly forceRefresh?: boolean;
  }) => Promise<string | null> | string | null;
}): ComputerUseHostFetch {
  return async (input, init) => {
    const requestUrl = new URL(input);
    const buildHeaders = async (token: string | null): Promise<Headers> => {
      const headers = await headersWithSessionCookies(
        params.session,
        [params.platformUrl, requestUrl],
        init?.headers,
      );
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
      params.addClientHeaders(headers);
      return headers;
    };

    const cachedToken = (await params.getCachedAuthToken?.()) ?? null;
    const response = await fetch(input, {
      ...init,
      headers: await buildHeaders(cachedToken),
    });
    if (response.status !== 401 || !params.getAuthToken) {
      return response;
    }

    const refreshedToken = await params.getAuthToken({ forceRefresh: true });
    if (!refreshedToken) {
      return response;
    }

    return fetch(input, {
      ...init,
      headers: await buildHeaders(refreshedToken),
    });
  };
}
