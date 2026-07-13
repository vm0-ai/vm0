import { z } from "zod";

import { CONNECTOR_REF_MAX_LENGTH } from "./connector-ref";

export const CONNECTOR_CATALOG_REF_MAX_LENGTH = CONNECTOR_REF_MAX_LENGTH;
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
