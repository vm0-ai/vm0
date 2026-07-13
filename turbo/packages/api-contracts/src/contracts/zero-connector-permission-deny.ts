import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorCatalogRefSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

const connectorPermissionDenyRequestSchema = z
  .object({
    method: z.string().min(1).max(16),
    url: z.string().min(1).max(8192),
  })
  .strict();

const connectorPermissionDenyMatchedSchema = z
  .object({
    outcome: z.literal("matched"),
    label: z.string().min(1),
    base: z.string().min(1),
    relativePath: z.string().min(1),
    permissions: z.array(z.string().min(1)).min(1),
  })
  .strict();

const connectorPermissionDenyUnknownEndpointSchema = z
  .object({
    outcome: z.literal("unknown-endpoint"),
    label: z.string().min(1),
    base: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();

const connectorPermissionDenyUnknownConnectorSchema = z
  .object({ outcome: z.literal("unknown-connector") })
  .strict();

const connectorPermissionDenyNoMatchingBaseSchema = z
  .object({
    outcome: z.literal("no-matching-base"),
    label: z.string().min(1),
  })
  .strict();

const connectorPermissionDenyUnresolvedDynamicBaseSchema = z
  .object({
    outcome: z.literal("unresolved-dynamic-base"),
    label: z.string().min(1),
  })
  .strict();

const connectorPermissionDenyUnsafeInputSchema = z
  .object({
    outcome: z.literal("unsafe-input"),
    reason: z.enum(["invalid-method", "invalid-url", "unsafe-path"]),
  })
  .strict();

export const connectorPermissionDenyDiagnosticResultSchema =
  z.discriminatedUnion("outcome", [
    connectorPermissionDenyMatchedSchema,
    connectorPermissionDenyUnknownEndpointSchema,
    connectorPermissionDenyUnknownConnectorSchema,
    connectorPermissionDenyNoMatchingBaseSchema,
    connectorPermissionDenyUnresolvedDynamicBaseSchema,
    connectorPermissionDenyUnsafeInputSchema,
  ]);

export type ConnectorPermissionDenyDiagnosticResult = z.infer<
  typeof connectorPermissionDenyDiagnosticResultSchema
>;

export const zeroConnectorPermissionDenyContract = c.router({
  diagnose: {
    method: "POST",
    path: "/api/zero/connectors/:connectorRef/diagnostics/permission-deny",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorRef: connectorCatalogRefSchema }),
    body: connectorPermissionDenyRequestSchema,
    responses: {
      200: connectorPermissionDenyDiagnosticResultSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Diagnose a connector permission denial",
  },
});

export type ZeroConnectorPermissionDenyContract =
  typeof zeroConnectorPermissionDenyContract;
