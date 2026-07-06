import type { Firewall } from "../firewall-types";
import {
  RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST,
  RUNNER_RUNTIME_FIREWALL_CATALOG_VERSION,
  hasGeneratedRunnerRuntimeFirewall,
  loadGeneratedRunnerRuntimeFirewall,
} from "./runner-runtime-loader.generated";

export {
  RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST,
  RUNNER_RUNTIME_FIREWALL_CATALOG_VERSION,
};

export function hasRunnerRuntimeFirewall(type: string): boolean {
  return hasGeneratedRunnerRuntimeFirewall(type);
}

export async function loadRunnerRuntimeFirewall(
  type: string,
): Promise<Firewall | null> {
  return await loadGeneratedRunnerRuntimeFirewall(type);
}

export async function loadRunnerRuntimeFirewalls(
  types: readonly string[],
): Promise<Record<string, Firewall>> {
  const entries = await Promise.all(
    types.map(async (type) => {
      const firewall = await loadRunnerRuntimeFirewall(type);
      if (!firewall) {
        throw new Error(`Missing runner runtime firewall: ${type}`);
      }
      return [type, firewall] as const;
    }),
  );
  return Object.fromEntries(entries);
}
