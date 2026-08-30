import {
  customConnectorHttpUpdateBodySchema,
  customConnectorMcpUpdateBodySchema,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { z } from "zod";

const customConnectorDefinitionFileSchema = z
  .union([
    customConnectorMcpUpdateBodySchema.strict(),
    customConnectorHttpUpdateBodySchema.strict(),
  ])
  .refine(
    (definition) => {
      return definition.authMode !== undefined;
    },
    { message: 'Custom connector authMode must be "manual" or "oauth"' },
  )
  .refine(
    (definition) => {
      return (
        definition.authMode !== "manual" || definition.oauthConfig === undefined
      );
    },
    {
      message: "Manual definitions cannot include oauthConfig",
    },
  );

function oauthDefinitionIsValid(
  definition: z.infer<typeof customConnectorDefinitionFileSchema>,
  requireClientSecret: boolean,
): boolean {
  if (definition.authMode !== "oauth") {
    return true;
  }
  return (
    definition.fields.length === 0 &&
    definition.oauthConfig?.providerAdapter === "standard" &&
    (!requireClientSecret || definition.oauthConfig.clientSecret !== undefined)
  );
}

export const createCustomConnectorDefinitionFileSchema =
  customConnectorDefinitionFileSchema.refine(
    (definition) => {
      return oauthDefinitionIsValid(definition, true);
    },
    {
      message:
        "OAuth definitions require empty fields and standard OAuth app configuration including clientSecret",
    },
  );

export const updateCustomConnectorDefinitionFileSchema =
  customConnectorDefinitionFileSchema.refine(
    (definition) => {
      return oauthDefinitionIsValid(definition, false);
    },
    {
      message:
        "OAuth definitions require empty fields and standard OAuth app configuration",
    },
  );
