import { z } from "zod";

export const CONNECTOR_REF_MAX_LENGTH = 64;
export const CONNECTOR_AUTH_METHOD_ID_MAX_LENGTH = 50;

const connectorIdentityPattern = /^[a-z0-9][a-z0-9-]*$/u;

export const connectorRefSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_REF_MAX_LENGTH)
  .regex(connectorIdentityPattern);

export const connectorAuthMethodIdSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_AUTH_METHOD_ID_MAX_LENGTH)
  .regex(connectorIdentityPattern);

export type ConnectorRef = z.infer<typeof connectorRefSchema>;
export type ConnectorAuthMethodId = z.infer<typeof connectorAuthMethodIdSchema>;
