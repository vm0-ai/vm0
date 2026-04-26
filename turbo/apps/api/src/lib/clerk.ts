import { createClerkClient } from "@clerk/backend";

import { env } from "./env";

let _client: ReturnType<typeof createClerkClient> | undefined;

export function clerk(): ReturnType<typeof createClerkClient> {
  _client ??= createClerkClient({
    secretKey: env("CLERK_SECRET_KEY"),
    publishableKey: env("CLERK_PUBLISHABLE_KEY"),
  });
  return _client;
}
