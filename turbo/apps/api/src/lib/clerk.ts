import { createClerkClient } from "@clerk/backend";

import { env } from "./env";
import { lazySingleton } from "./lazy-singleton";

export const clerk = lazySingleton((): ReturnType<typeof createClerkClient> => {
  return createClerkClient({
    secretKey: env("CLERK_SECRET_KEY"),
    publishableKey: env("CLERK_PUBLISHABLE_KEY"),
  });
});
