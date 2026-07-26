import { z } from "zod";

import {
  connectorAuthMethodIdSchema,
  connectorRefSchema,
} from "./connector-identity";

export const connectorCatalogSyncFailureCodeSchema = z.enum([
  "source-unavailable",
  "object-too-large",
  "invalid-json",
  "invalid-pointer",
  "invalid-reference",
  "digest-mismatch",
  "unsupported-schema",
  "invalid-artifact",
  "public-leakage",
  "relationship-mismatch",
  "invalid-compression",
]);

export const connectorCatalogCompatibilityReasonSchema = z.enum([
  "missing-grant-provider",
  "missing-access-provider",
  "missing-revoke-provider",
  "provider-contract-mismatch",
  "missing-platform-configuration",
]);

export const connectorCatalogFilteredAuthMethodSchema = z.object({
  connectorRef: connectorRefSchema,
  authMethodId: connectorAuthMethodIdSchema,
  reasons: z.array(connectorCatalogCompatibilityReasonSchema).min(1),
});

export const connectorCatalogFilteredAuthMethodsSchema = z.array(
  connectorCatalogFilteredAuthMethodSchema,
);

export const connectorCatalogFilteringStatusSchema = z.object({
  capabilityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  evaluatedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  filteredAuthMethods: connectorCatalogFilteredAuthMethodsSchema,
});

export const connectorCredentialStorageReadinessSchema = z.object({
  missingConnectorVersions: z.number().int().nonnegative(),
  unownedConnectorSecrets: z.number().int().nonnegative(),
  unownedConnectorVariables: z.number().int().nonnegative(),
  unresolvedBridgeCredentials: z.number().int().nonnegative(),
});

export const connectorCatalogDiagnosticsSchema = z.object({
  state: z.enum(["never-synced", "current", "stale"]),
  active: z
    .object({
      catalogVersion: z.string(),
      catalogDigest: z.string(),
      activatedAt: z.string().datetime(),
    })
    .nullable(),
  lastAttempt: z
    .object({
      at: z.string().datetime(),
      outcome: z.enum(["accepted", "unchanged", "rejected"]),
      failureCode: connectorCatalogSyncFailureCodeSchema.nullable(),
      reusedCachedRejection: z.boolean(),
    })
    .nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  rejectedCandidate: z
    .object({
      catalogVersion: z.string().nullable(),
      catalogDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/u)
        .nullable(),
      failureCode: connectorCatalogSyncFailureCodeSchema,
      backendVersion: z
        .string()
        .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
    })
    .nullable(),
  filtering: connectorCatalogFilteringStatusSchema,
  credentialStorage: connectorCredentialStorageReadinessSchema,
});

export type ConnectorCatalogSyncFailureCode = z.infer<
  typeof connectorCatalogSyncFailureCodeSchema
>;
export type ConnectorCatalogCompatibilityReason = z.infer<
  typeof connectorCatalogCompatibilityReasonSchema
>;
export type ConnectorCatalogFilteredAuthMethod = z.infer<
  typeof connectorCatalogFilteredAuthMethodSchema
>;
export type ConnectorCatalogFilteringStatus = z.infer<
  typeof connectorCatalogFilteringStatusSchema
>;
export type ConnectorCredentialStorageReadiness = z.infer<
  typeof connectorCredentialStorageReadinessSchema
>;
export type ConnectorCatalogDiagnostics = z.infer<
  typeof connectorCatalogDiagnosticsSchema
>;
