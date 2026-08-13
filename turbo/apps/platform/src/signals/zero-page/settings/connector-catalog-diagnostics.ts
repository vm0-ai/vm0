import type { ConnectorCatalogDiagnostics } from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import { zeroConnectorCatalogContract } from "@okouai/api-contracts/contracts/zero-connector-catalog";
import { computed } from "ccstate";

import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../api-client.ts";

export const connectorCatalogDiagnostics$ = computed(
  async (get): Promise<ConnectorCatalogDiagnostics | null> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroConnectorCatalogContract);
    const result = await accept(client.diagnostics(), [200, 403, 404]);

    return result.status === 200 ? result.body : null;
  },
);
