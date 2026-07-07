import {
  PLATFORM_CLIENT_REQUEST_ID_HEADER,
  PLATFORM_CLIENT_SESSION_ID_HEADER,
  PLATFORM_CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/platform-client-headers";

import { getBuildVersion } from "../lib/build-info.ts";

function readPlatformClientVersion(): string {
  const version = getBuildVersion();
  if (version === null) {
    throw new Error("VITE_APP_VERSION is required for platform client headers");
  }
  return version;
}

const platformClientVersion = readPlatformClientVersion();
const platformClientSessionId = crypto.randomUUID();

function createPlatformClientHeaders(): Record<string, string> {
  return {
    [PLATFORM_CLIENT_VERSION_HEADER]: platformClientVersion,
    [PLATFORM_CLIENT_SESSION_ID_HEADER]: platformClientSessionId,
    [PLATFORM_CLIENT_REQUEST_ID_HEADER]: crypto.randomUUID(),
  };
}

export function addPlatformClientHeaders(headers: Headers): void {
  for (const [key, value] of Object.entries(createPlatformClientHeaders())) {
    headers.set(key, value);
  }
}
