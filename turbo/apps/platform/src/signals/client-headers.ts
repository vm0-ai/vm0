import {
  addClientCapabilityToVersion,
  CLIENT_CAPABILITY_JA_JP_LOCALE,
  CLIENT_CAPABILITY_KO_KR_LOCALE,
  CLIENT_CAPABILITY_ID_ID_LOCALE,
  CLIENT_CAPABILITY_PT_BR_LOCALE,
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
    [CLIENT_VERSION_HEADER]: addClientCapabilityToVersion(
      addClientCapabilityToVersion(
        addClientCapabilityToVersion(
          addClientCapabilityToVersion(
            clientVersion,
            CLIENT_CAPABILITY_PT_BR_LOCALE,
          ),
          CLIENT_CAPABILITY_JA_JP_LOCALE,
        ),
        CLIENT_CAPABILITY_KO_KR_LOCALE,
      ),
      CLIENT_CAPABILITY_ID_ID_LOCALE,
    ),
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
