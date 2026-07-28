import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
  ZERO_MAIL_CLIENT_VERSION,
  ZERO_MAIL_CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";

import { getBuildVersion } from "../lib/build-info.ts";

function readClientVersion(): string {
  const version = getBuildVersion();
  if (version === null) {
    throw new Error("VITE_APP_VERSION is required for client headers");
  }
  return version;
}

const clientVersion = readClientVersion();
const clientSessionId = crypto.randomUUID();

function createClientHeaders(): Record<string, string> {
  return {
    [CLIENT_VERSION_HEADER]: clientVersion,
    [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
    [CLIENT_SESSION_ID_HEADER]: clientSessionId,
    [CLIENT_REQUEST_ID_HEADER]: crypto.randomUUID(),
    [ZERO_MAIL_CLIENT_VERSION_HEADER]: ZERO_MAIL_CLIENT_VERSION,
  };
}

export function addClientHeaders(headers: Headers): void {
  for (const [key, value] of Object.entries(createClientHeaders())) {
    headers.set(key, value);
  }
}
