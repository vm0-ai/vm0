import {
  initClient,
  tsRestFetchApi,
  type AppRouter,
  type InitClientArgs,
  type InitClientReturn,
} from "@ts-rest/core";

export function resolveApiBase(_preferShadow: boolean): string {
  return process.env.EXPO_PUBLIC_API_URL ?? "https://api.vm0.ai";
}

interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly resolvePath?: (path: string) => Promise<string> | string;
}

export function createAuthedTsRestClient<T extends AppRouter>(
  contract: T,
  options: AuthedClientOptions,
): InitClientReturn<T, InitClientArgs> {
  return initClient(contract, {
    baseUrl: options.baseUrl,
    jsonQuery: false,
    validateResponse: false,
    api: async (args: Parameters<typeof tsRestFetchApi>[0]) => {
      const token = await options.getToken();
      const path = options.resolvePath
        ? await options.resolvePath(args.path)
        : args.path;

      const headers = token
        ? { ...args.headers, Authorization: `Bearer ${token}` }
        : args.headers;

      return tsRestFetchApi({ ...args, headers, path });
    },
  });
}
