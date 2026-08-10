import {
  customConnectorHttpUpdateBodySchema,
  customConnectorMcpUpdateBodySchema,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
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
      if (definition.authMode !== "manual") {
        return true;
      }
      const field = definition.fields[0];
      return (
        definition.oauthConfig === undefined &&
        definition.fields.length === 1 &&
        field?.key === "secret" &&
        field.kind === "secret" &&
        field.required
      );
    },
    {
      message:
        'Manual definitions require exactly one required secret field with key "secret" and no oauthConfig',
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
