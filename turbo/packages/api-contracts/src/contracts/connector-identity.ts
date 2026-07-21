import { z } from "zod";

export const CONNECTOR_CATALOG_REF_MAX_LENGTH = 64;
export const CONNECTOR_CATALOG_AUTH_METHOD_ID_MAX_LENGTH = 50;

const connectorCatalogIdentityPattern = /^[a-z0-9][a-z0-9-]*$/u;

export const connectorCatalogRefSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_CATALOG_REF_MAX_LENGTH)
  .regex(connectorCatalogIdentityPattern);

export const connectorCatalogAuthMethodIdSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_CATALOG_AUTH_METHOD_ID_MAX_LENGTH)
  .regex(connectorCatalogIdentityPattern);

export type ConnectorCatalogRef = z.infer<typeof connectorCatalogRefSchema>;
export type ConnectorCatalogAuthMethodId = z.infer<
  typeof connectorCatalogAuthMethodIdSchema
>;
