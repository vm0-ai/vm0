import {
  modelProviderCooldownDiagnosticsContract,
  type BuiltInModelCooldownDiagnostics,
} from "@okouai/api-contracts/contracts/model-provider-routes";
import { command, computed, state } from "ccstate";

import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

const internalBuiltInModelCooldownDiagnosticsReload$ = state(0);

export const reloadBuiltInModelCooldownDiagnostics$ = command(({ set }) => {
  set(internalBuiltInModelCooldownDiagnosticsReload$, (value) => {
    return value + 1;
  });
});

export const builtInModelCooldownDiagnostics$ = computed(
  async (get): Promise<BuiltInModelCooldownDiagnostics | null> => {
    get(internalBuiltInModelCooldownDiagnosticsReload$);
    const createClient = get(apiClient$);
    const client = createClient(modelProviderCooldownDiagnosticsContract);
    const result = await accept(client.get(), [200, 403, 404]);

    return result.status === 200 ? result.body : null;
  },
);
