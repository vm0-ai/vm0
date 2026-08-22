import type { ConnectorCatalogDiagnostics } from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { command, computed, state } from "ccstate";

import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

const internalConnectorCatalogDiagnosticsReload$ = state(0);

export const reloadConnectorCatalogDiagnostics$ = command(({ set }) => {
  set(internalConnectorCatalogDiagnosticsReload$, (value) => {
    return value + 1;
  });
});

export const connectorCatalogDiagnostics$ = computed(
  async (get): Promise<ConnectorCatalogDiagnostics | null> => {
    get(internalConnectorCatalogDiagnosticsReload$);
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(client.diagnostics(), [200, 403, 404]);

    return result.status === 200 ? result.body : null;
  },
);
