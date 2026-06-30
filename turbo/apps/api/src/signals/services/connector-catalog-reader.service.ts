import type { ConnectorSearchItem } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
} from "@vm0/connectors/connectors";
import {
  getAvailableConnectorAuthMethodIds,
  getConnectorTags,
  type ApiAuthMethodPolicy,
  type ConnectorFeatureStates,
} from "@vm0/connectors/connector-utils";

interface ConnectorCatalogSearchArgs {
  readonly keyword: string | undefined;
  readonly featureStates: ConnectorFeatureStates;
  readonly apiAuthMethodPolicy?: ApiAuthMethodPolicy;
}

export function searchConnectorCatalog(
  args: ConnectorCatalogSearchArgs,
): Promise<ConnectorSearchItem[]> {
  const keyword = args.keyword?.toLowerCase();

  const connectors = CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const config = CONNECTOR_TYPES[type];
    const authMethods = getAvailableConnectorAuthMethodIds(
      type,
      args.featureStates,
      {
        apiAuthMethodPolicy: args.apiAuthMethodPolicy ?? "include",
      },
    );

    if (authMethods.length === 0) {
      return [];
    }

    const item = {
      id: type,
      label: config.label,
      description: config.helpText,
      authMethods,
    };
    const tags = getConnectorTags(type);

    if (
      keyword &&
      !item.label.toLowerCase().includes(keyword) &&
      !item.description.toLowerCase().includes(keyword) &&
      !tags.some((tag) => {
        return tag.toLowerCase().includes(keyword);
      })
    ) {
      return [];
    }

    return [item];
  });

  return Promise.resolve(connectors);
}
