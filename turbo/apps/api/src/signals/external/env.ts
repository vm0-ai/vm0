import { computed, type Computed } from "ccstate";

import { env, type EnvKey } from "../../lib/env";

function envComputed<K extends EnvKey>(
  name: K,
): Computed<ReturnType<typeof env<K>>> {
  return computed(() => {
    return env(name);
  });
}

export const vercelEnv$ = envComputed("VERCEL_ENV");
