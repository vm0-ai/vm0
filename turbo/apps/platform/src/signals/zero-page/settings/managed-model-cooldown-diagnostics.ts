import {
  modelProviderCooldownDiagnosticsContract,
  type ManagedModelCooldownDiagnostics,
} from "@okouai/api-contracts/contracts/model-provider-routes";
import { command, computed, state } from "ccstate";

import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

const internalManagedModelCooldownDiagnosticsReload$ = state(0);

export const reloadManagedModelCooldownDiagnostics$ = command(({ set }) => {
  set(internalManagedModelCooldownDiagnosticsReload$, (value) => {
    return value + 1;
  });
});

export const managedModelCooldownDiagnostics$ = computed(
  async (get): Promise<ManagedModelCooldownDiagnostics | null> => {
    get(internalManagedModelCooldownDiagnosticsReload$);
    const createClient = get(apiClient$);
    const client = createClient(modelProviderCooldownDiagnosticsContract);
    const result = await accept(client.get(), [200, 403, 404]);

    return result.status === 200 ? result.body : null;
  },
);
