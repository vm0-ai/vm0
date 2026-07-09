import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const nintendoEshopCatalog = {
  "nintendo-eshop-catalog": {
    label: "Nintendo eShop Catalog",
    category: "data-automation-infrastructure",
    tags: ["gaming", "nintendo", "switch", "eshop", "catalog", "pricing"],
    helpText:
      "Enable public Nintendo eShop catalog, search, metadata, and regional pricing data.",
    authMethods: {
      api: {
        featureFlag: FeatureSwitchKey.NintendoEshopCatalogConnector,
        label: "Public catalog",
        helpText:
          "Enable public Nintendo eShop catalog and regional pricing data. No Nintendo Account sign-in is required.",
        storage: {
          secrets: [],
          variables: [],
        },
        grant: { kind: "none" },
        access: { kind: "none" },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
