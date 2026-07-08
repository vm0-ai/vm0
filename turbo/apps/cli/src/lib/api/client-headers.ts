import { randomUUID } from "node:crypto";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import {
  trpcRestFetchApi,
  type ApiFetcher,
} from "@vm0/api-contracts/contracts/trpc-contract";

declare const __CLI_VERSION__: string;

type CliClientHeaderInjector = (headers: Headers) => void;

export function createCliClientHeaderInjector(options: {
  readonly clientVersion: string;
  readonly createUuid?: () => string;
}): CliClientHeaderInjector {
  const createUuid = options.createUuid ?? randomUUID;
  const clientSessionId = createUuid();

  return (headers) => {
    headers.set(CLIENT_VERSION_HEADER, options.clientVersion);
    headers.set(CLIENT_TYPE_HEADER, CLIENT_TYPE_CLI);
    headers.set(CLIENT_SESSION_ID_HEADER, clientSessionId);
    headers.set(CLIENT_REQUEST_ID_HEADER, createUuid());
  };
}

const addDefaultCliClientHeaders = createCliClientHeaderInjector({
  clientVersion: __CLI_VERSION__,
});

function addCliClientHeaders(headers: Headers): void {
  addDefaultCliClientHeaders(headers);
}

export function headersWithCliClientHeaders(
  headers?: NonNullable<RequestInit["headers"]>,
): Headers {
  const mergedHeaders = new Headers(headers);
  addCliClientHeaders(mergedHeaders);
  return mergedHeaders;
}

export const cliClientHeaderApi: ApiFetcher = (args) => {
  return trpcRestFetchApi({
    ...args,
    headers: headersWithCliClientHeaders(args.headers),
  });
};
