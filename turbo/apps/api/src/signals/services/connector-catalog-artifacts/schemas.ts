import { z } from "zod";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const connectorRefSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const authMethodIdSchema = z.string().min(1);
const publicFieldIdSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*$/);
const artifactKeySchema = z
  .string()
  .min(1)
  .refine((key) => {
    const segments = key.split("/");
    return (
      !key.startsWith("/") &&
      !key.includes("..") &&
      !key.includes("\\") &&
      segments.every((segment) => {
        return segment.length > 0 && segment !== ".";
      })
    );
  }, "Artifact keys must be relative object keys");

export const SUPPORTED_CONNECTOR_CATALOG_ACTIVE_SCHEMA_VERSION = 1;
export const SUPPORTED_CONNECTOR_CATALOG_ARTIFACT_SCHEMA_VERSION = 1;

export function isSupportedConnectorCatalogCapability(
  capability: string,
): boolean {
  return /^(catalog\.public-connectors@1|catalog\.private-field-mapping@1|grant\.manual@1|grant\.auth-code@1|grant\.device-auth@1|firewall\.permission-metadata@1)$/.test(
    capability,
  );
}

const connectorCatalogArtifactReferenceSchema = z
  .object({
    key: artifactKeySchema,
    digest: digestSchema,
  })
  .strict();

export function parseConnectorCatalogArtifactKey(key: string): string {
  return artifactKeySchema.parse(key);
}

export const connectorCatalogActivePointerSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    catalogVersion: z.string().min(1),
    manifestKey: artifactKeySchema,
    manifestDigest: digestSchema,
    publishedAt: z.string().datetime(),
  })
  .strict();

export const connectorCatalogManifestSchema = z
  .object({
    catalogVersion: z.string().min(1),
    artifactSchemaVersion: z.number().int().positive(),
    requiredCapabilities: z.array(z.string().min(1)),
    artifacts: z
      .object({
        public: connectorCatalogArtifactReferenceSchema,
        private: connectorCatalogArtifactReferenceSchema,
      })
      .strict(),
  })
  .strict();

const publicFirewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);

const publicConnectorCatalogPermissionSummarySchema = z
  .object({
    hasPermissions: z.boolean(),
    permissionCount: z.number().int().nonnegative(),
    hasCategories: z.boolean(),
    hasDefaultPolicyOverrides: z.boolean(),
  })
  .strict();

const publicConnectorCatalogAuthMethodSummarySchema = z
  .object({
    id: authMethodIdSchema,
    label: z.string().min(1),
    description: z.string().nullable(),
    grantKind: z.enum([
      "manual",
      "auth-code",
      "external-code",
      "device-auth",
      "managed",
    ]),
  })
  .strict();

const publicConnectorCatalogManualFieldSchema = z
  .object({
    id: publicFieldIdSchema,
    label: z.string().min(1),
    required: z.boolean(),
    placeholder: z.string().nullable(),
    inputType: z.enum(["password", "text"]),
  })
  .strict();

const publicConnectorCatalogStartOptionChoiceSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

const publicConnectorCatalogStartOptionSchema = z
  .object({
    id: publicFieldIdSchema,
    kind: z.literal("select"),
    label: z.string().min(1),
    required: z.boolean(),
    defaultValue: z.string().nullable(),
    options: z.array(publicConnectorCatalogStartOptionChoiceSchema),
  })
  .strict();

const publicConnectorCatalogAuthMethodDetailSchema =
  publicConnectorCatalogAuthMethodSummarySchema
    .extend({
      manualFields: z.array(publicConnectorCatalogManualFieldSchema),
      startOptions: z.array(publicConnectorCatalogStartOptionSchema),
    })
    .strict();

export const publicConnectorCatalogArtifactConnectorSchema = z
  .object({
    connectorRef: connectorRefSchema,
    label: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    generation: z.array(z.string().min(1)),
    tags: z.array(z.string().min(1)),
    authMethods: z.array(publicConnectorCatalogAuthMethodDetailSchema).min(1),
    permissionSummary: publicConnectorCatalogPermissionSummarySchema,
  })
  .strict();

const publicConnectorCatalogPermissionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

const publicConnectorCatalogPermissionCategoriesSchema = z
  .object({
    categories: z.record(z.string().min(1), z.string().min(1)),
    displayOrder: z.array(z.string().min(1)),
  })
  .strict();

const publicConnectorCatalogDefaultPolicySchema = z
  .object({
    permissionDefault: publicFirewallPolicyValueSchema,
    permissionOverrides: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        ask: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    unknownPolicy: publicFirewallPolicyValueSchema,
  })
  .strict();

export const publicConnectorCatalogArtifactPermissionSchema = z
  .object({
    connectorRef: connectorRefSchema,
    label: z.string().min(1),
    permissionCount: z.number().int().nonnegative(),
    permissions: z.array(publicConnectorCatalogPermissionSchema),
    categories: publicConnectorCatalogPermissionCategoriesSchema.nullable(),
    defaultPolicy: publicConnectorCatalogDefaultPolicySchema,
  })
  .strict();

export const connectorCatalogPublicArtifactSchema = z
  .object({
    artifactSchemaVersion: z.number().int().positive(),
    catalogVersion: z.string().min(1),
    connectors: z.array(publicConnectorCatalogArtifactConnectorSchema),
    permissions: z.array(publicConnectorCatalogArtifactPermissionSchema),
  })
  .strict();

const privateManualFieldMappingSchema = z
  .object({
    publicId: publicFieldIdSchema,
    privateName: z.string().min(1),
    storage: z.enum(["secret", "variable"]),
    runtimeName: z.string().min(1),
  })
  .strict();

const privateStartOptionMappingSchema = z
  .object({
    publicId: publicFieldIdSchema,
    privateName: z.string().min(1),
    runtimeName: z.string().min(1),
  })
  .strict();

const privateRuntimeArtifactReferenceSchema =
  connectorCatalogArtifactReferenceSchema
    .extend({
      kind: z.string().min(1),
    })
    .strict();

const privateAuthMethodMappingSchema = z
  .object({
    id: authMethodIdSchema,
    manualFieldMappings: z.array(privateManualFieldMappingSchema),
    startOptionMappings: z.array(privateStartOptionMappingSchema),
  })
  .strict();

const privateConnectorMappingSchema = z
  .object({
    connectorRef: connectorRefSchema,
    authMethods: z.array(privateAuthMethodMappingSchema),
    runtimeArtifactRefs: z.array(privateRuntimeArtifactReferenceSchema),
  })
  .strict();

export const connectorCatalogPrivateArtifactSchema = z
  .object({
    artifactSchemaVersion: z.number().int().positive(),
    catalogVersion: z.string().min(1),
    connectors: z.array(privateConnectorMappingSchema),
  })
  .strict();

export type ConnectorCatalogActivePointer = z.infer<
  typeof connectorCatalogActivePointerSchema
>;
export type ConnectorCatalogManifest = z.infer<
  typeof connectorCatalogManifestSchema
>;
export type ConnectorCatalogPublicArtifact = z.infer<
  typeof connectorCatalogPublicArtifactSchema
>;
export type ConnectorCatalogPublicArtifactConnector = z.infer<
  typeof publicConnectorCatalogArtifactConnectorSchema
>;
export type ConnectorCatalogPublicArtifactPermission = z.infer<
  typeof publicConnectorCatalogArtifactPermissionSchema
>;
export type ConnectorCatalogPrivateArtifact = z.infer<
  typeof connectorCatalogPrivateArtifactSchema
>;
