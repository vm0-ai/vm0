import { computed, type Computed } from "ccstate";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@vm0/db/schema/org-custom-connector-oauth-config";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./zero-custom-connector.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import {
  loadCurrentCustomConnectorValueMarkers,
  loadUsableCustomConnectorConnectionIds,
} from "./custom-connector-credential-access.service";

export function zeroCustomConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly CustomConnectorResponse[]>> {
  return computed(async (get): Promise<readonly CustomConnectorResponse[]> => {
    const db = get(db$);
    const [connectorRows, markers, usableConnections] = await Promise.all([
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
      loadUsableCustomConnectorConnectionIds(db, args),
    ]);
    return connectorRows.map((row) => {
      return serialiseCustomConnector({
        row: normaliseCustomConnectorRow(row.connector, row.oauthConfig),
        valueMarkers: markers,
        usableConnection: usableConnections.has(row.connector.id),
      });
    });
  });
}
