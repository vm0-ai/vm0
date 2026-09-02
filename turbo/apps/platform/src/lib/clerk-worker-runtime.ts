import { Clerk } from "@clerk/clerk-js/no-rhc";

import { resolveClerkInstanceConfig } from "./clerk-instance-config.ts";
import type { ClerkTokenSource } from "../signals/clerk-token.ts";

export async function startClerkWorkerRuntime(): Promise<ClerkTokenSource> {
  const { publishableKey, satelliteConfig } = resolveClerkInstanceConfig();
  const clerk = new Clerk(
    publishableKey,
    satelliteConfig ? { domain: satelliteConfig.domain } : undefined,
  );
  await clerk.load({
    standardBrowser: false,
    ...(satelliteConfig
      ? {
          isSatellite: satelliteConfig.isSatellite,
          satelliteAutoSync: satelliteConfig.satelliteAutoSync,
        }
      : {}),
  });
  return clerk;
}
