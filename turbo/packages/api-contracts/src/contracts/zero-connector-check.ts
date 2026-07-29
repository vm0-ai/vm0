import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

const boundedNameSchema = z.string().min(1).max(255);

const connectorCheckUrlRequestSchema = z
  .object({
    mode: z.literal("url"),
    method: z.string().min(1).max(16),
    url: z.string().min(1).max(8192),
    // TODO(#23619): Rename connector-check wire fields after clients migrate.
    connectorRef: connectorSlugSchema.optional(),
    environmentName: boundedNameSchema.optional(),
  })
  .strict();

const connectorCheckEnvironmentRequestSchema = z
  .object({
    mode: z.literal("environment"),
    environmentName: boundedNameSchema,
    permission: boundedNameSchema.optional(),
  })
  .strict();

export const connectorCheckRequestSchema = z.discriminatedUnion("mode", [
  connectorCheckUrlRequestSchema,
  connectorCheckEnvironmentRequestSchema,
]);

export type ConnectorCheckRequest = z.infer<typeof connectorCheckRequestSchema>;

const connectorCheckIdentitySchema = z
  .object({
    // TODO(#23619): Rename with the connector-check response contract.
    connectorRef: connectorSlugSchema,
    label: z.string().min(1),
    visibility: z.enum(["available", "unavailable"]),
    credentialResolution: z.enum(["network-boundary", "none"]),
  })
  .strict();

const connectorCheckCandidateSchema = z
  .object({
    // TODO(#23619): Rename with the connector-check response contract.
    connectorRef: connectorSlugSchema,
    label: z.string().min(1),
  })
  .strict();

const connectorCheckNotScopedRunSchema = z
  .object({ status: z.literal("not-scoped") })
  .strict();

const connectorCheckConfiguredRunSchema = z
  .object({
    status: z.literal("configured"),
    bases: z.array(z.string().min(1)),
  })
  .strict();

const connectorCheckNotConfiguredRunSchema = z
  .object({ status: z.literal("not-configured") })
  .strict();

const connectorCheckRunSchema = z.discriminatedUnion("status", [
  connectorCheckNotScopedRunSchema,
  connectorCheckConfiguredRunSchema,
  connectorCheckNotConfiguredRunSchema,
]);

const connectorCheckAllowPolicySchema = z
  .object({
    outcome: z.literal("allow"),
    basis: z.enum(["allow-list", "not-blocked", "no-policy", "unknown-policy"]),
  })
  .strict();

const connectorCheckDenyPolicySchema = z
  .object({
    outcome: z.literal("deny"),
    basis: z.enum(["deny-list", "unknown-policy"]),
  })
  .strict();

const connectorCheckAskPolicySchema = z
  .object({
    outcome: z.literal("ask"),
    basis: z.enum(["ask-list", "unknown-policy"]),
  })
  .strict();

const connectorCheckUnavailablePolicySchema = z
  .object({
    outcome: z.literal("unavailable"),
    basis: z.enum([
      "not-run-scoped",
      "policies-unavailable",
      "connector-not-configured",
    ]),
  })
  .strict();

export const connectorCheckPolicySchema = z.discriminatedUnion("outcome", [
  connectorCheckAllowPolicySchema,
  connectorCheckDenyPolicySchema,
  connectorCheckAskPolicySchema,
  connectorCheckUnavailablePolicySchema,
]);

export type ConnectorCheckPolicy = z.infer<typeof connectorCheckPolicySchema>;

const connectorCheckMatchedPermissionSchema = z
  .object({
    name: z.string().min(1),
    policy: connectorCheckPolicySchema,
  })
  .strict();

const connectorCheckMatchedPermissionsSchema = z
  .object({
    kind: z.literal("matched"),
    permissions: z.array(connectorCheckMatchedPermissionSchema).min(1),
  })
  .strict();

const connectorCheckUnknownEndpointSchema = z
  .object({
    kind: z.literal("unknown-endpoint"),
    policy: connectorCheckPolicySchema,
  })
  .strict();

const connectorCheckPermissionResultSchema = z.discriminatedUnion("kind", [
  connectorCheckMatchedPermissionsSchema,
  connectorCheckUnknownEndpointSchema,
]);

const connectorCheckResolvedUrlSchema = z
  .object({
    outcome: z.literal("resolved"),
    mode: z.literal("url"),
    connector: connectorCheckIdentitySchema,
    environmentNames: z.array(boundedNameSchema).nullable(),
    run: connectorCheckRunSchema,
    method: z.string().min(1).max(16),
    base: z.string().min(1),
    relativePath: z.string().min(1),
    permission: connectorCheckPermissionResultSchema,
  })
  .strict();

const connectorCheckResolvedEnvironmentSchema = z
  .object({
    outcome: z.literal("resolved"),
    mode: z.literal("environment"),
    connector: connectorCheckIdentitySchema,
    environmentName: boundedNameSchema,
    run: connectorCheckRunSchema,
    permission: connectorCheckPolicySchema.nullable(),
  })
  .strict();

const connectorCheckUnsafeInputSchema = z
  .object({
    outcome: z.literal("unsafe-input"),
    reason: z.enum(["invalid-method", "invalid-url", "unsafe-path"]),
  })
  .strict();

const connectorCheckUnknownConnectorSchema = z
  .object({ outcome: z.literal("unknown-connector") })
  .strict();

const connectorCheckUnknownEnvironmentSchema = z
  .object({ outcome: z.literal("unknown-environment") })
  .strict();

const connectorCheckNoMatchSchema = z
  .object({
    outcome: z.literal("no-match"),
    scope: z.enum(["run", "catalog"]),
  })
  .strict();

const connectorCheckAmbiguousSchema = z
  .object({
    outcome: z.literal("ambiguous"),
    candidates: z.array(connectorCheckCandidateSchema).min(2),
  })
  .strict();

const connectorCheckMismatchSchema = z
  .object({
    outcome: z.literal("connector-mismatch"),
    connector: connectorCheckIdentitySchema,
  })
  .strict();

const connectorCheckEnvironmentNotOwnedSchema = z
  .object({
    outcome: z.literal("environment-not-owned"),
    connector: connectorCheckIdentitySchema,
  })
  .strict();

const connectorCheckEnvironmentNotUsedSchema = z
  .object({
    outcome: z.literal("environment-not-used"),
    connector: connectorCheckIdentitySchema,
    environmentNames: z.array(boundedNameSchema),
  })
  .strict();

const connectorCheckUnresolvedDynamicBaseSchema = z
  .object({
    outcome: z.literal("unresolved-dynamic-base"),
    connector: connectorCheckIdentitySchema,
  })
  .strict();

const connectorCheckRunContextUnavailableSchema = z
  .object({ outcome: z.literal("run-context-unavailable") })
  .strict();

export const connectorCheckDiagnosticResultSchema = z.union([
  connectorCheckResolvedUrlSchema,
  connectorCheckResolvedEnvironmentSchema,
  connectorCheckUnsafeInputSchema,
  connectorCheckUnknownConnectorSchema,
  connectorCheckUnknownEnvironmentSchema,
  connectorCheckNoMatchSchema,
  connectorCheckAmbiguousSchema,
  connectorCheckMismatchSchema,
  connectorCheckEnvironmentNotOwnedSchema,
  connectorCheckEnvironmentNotUsedSchema,
  connectorCheckUnresolvedDynamicBaseSchema,
  connectorCheckRunContextUnavailableSchema,
]);

export type ConnectorCheckDiagnosticResult = z.infer<
  typeof connectorCheckDiagnosticResultSchema
>;

export const zeroConnectorCheckContract = c.router({
  check: {
    method: "POST",
    path: "/api/zero/connectors/diagnostics/check",
    headers: authHeadersSchema,
    body: connectorCheckRequestSchema,
    responses: {
      200: connectorCheckDiagnosticResultSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve connector runtime diagnostics",
  },
});

export type ZeroConnectorCheckContract = typeof zeroConnectorCheckContract;
