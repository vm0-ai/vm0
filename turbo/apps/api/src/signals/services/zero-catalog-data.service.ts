import { computed, type Computed } from "ccstate";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./zero-custom-connector.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import {
  customConnectorDefinitionHasConnectedConnection,
  loadCurrentCustomConnectorValueMarkers,
  loadConnectedCustomConnectorConnections,
} from "./custom-connector-credential-access.service";

export function zeroCustomConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly CustomConnectorResponse[]>> {
  return computed(async (get): Promise<readonly CustomConnectorResponse[]> => {
    const db = get(db$);
    const [connectorRows, markers, connectedConnections] = await Promise.all([
      db
        .select({
          connector: customConnectorDefinitionSelection(),
          oauthConfig: orgCustomConnectorOauthConfigs,
        })
        .from(orgCustomConnectors)
        .leftJoin(
          orgCustomConnectorOauthConfigs,
          and(
            eq(
              orgCustomConnectorOauthConfigs.connectorId,
              orgCustomConnectors.id,
            ),
            eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
          ),
        )
        .where(eq(orgCustomConnectors.orgId, args.orgId))
        .orderBy(orgCustomConnectors.displayName),
      loadCurrentCustomConnectorValueMarkers(db, args),
      loadConnectedCustomConnectorConnections(db, args),
    ]);
    return connectorRows.map((row) => {
      return serialiseCustomConnector({
        row: normaliseCustomConnectorRow(row.connector, row.oauthConfig),
        valueMarkers: markers,
        connectedConnection: customConnectorDefinitionHasConnectedConnection({
          connectedConnections,
          definition: row.connector,
        }),
      });
    });
  });
}
