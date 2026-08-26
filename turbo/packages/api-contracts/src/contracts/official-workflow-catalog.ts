import { z } from "zod";

import { automationEventTypeSchema, workflowNameSchema } from "./workflows";

export const OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION = 1 as const;

export const officialWorkflowLifecycleSchema = z.enum(["active", "retired"]);
export type OfficialWorkflowLifecycle = z.infer<
  typeof officialWorkflowLifecycleSchema
>;

export const officialWorkflowBlueprintKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

export const officialWorkflowParameterKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

const officialWorkflowUserTimezoneDerivationSchema = z
  .object({ kind: z.literal("user-timezone") })
  .strict();

const officialWorkflowParameterBaseShape = {
  key: officialWorkflowParameterKeySchema,
  required: z.boolean(),
};

const officialWorkflowStringParameterSchema = z
  .object({
    ...officialWorkflowParameterBaseShape,
    type: z.literal("string"),
    format: z
      .enum(["text", "uuid", "timezone", "date-time", "url"])
      .default("text"),
    default: z.string().optional(),
    derivation: officialWorkflowUserTimezoneDerivationSchema.optional(),
  })
  .strict();

const officialWorkflowIntegerParameterSchema = z
  .object({
    ...officialWorkflowParameterBaseShape,
    type: z.literal("integer"),
    default: z.number().int().safe().optional(),
  })
  .strict();

const officialWorkflowBooleanParameterSchema = z
  .object({
    ...officialWorkflowParameterBaseShape,
    type: z.literal("boolean"),
    default: z.boolean().optional(),
  })
  .strict();

export const officialWorkflowInstallationParameterSchema = z.discriminatedUnion(
  "type",
  [
    officialWorkflowStringParameterSchema,
    officialWorkflowIntegerParameterSchema,
    officialWorkflowBooleanParameterSchema,
  ],
);
export type OfficialWorkflowInstallationParameter = z.infer<
  typeof officialWorkflowInstallationParameterSchema
>;

export const officialWorkflowParameterReferenceSchema = z
  .object({ parameter: officialWorkflowParameterKeySchema })
  .strict();
export type OfficialWorkflowParameterReference = z.infer<
  typeof officialWorkflowParameterReferenceSchema
>;

export type OfficialWorkflowTemplateJsonValue =
  | null
  | boolean
  | number
  | string
  | OfficialWorkflowParameterReference
  | readonly OfficialWorkflowTemplateJsonValue[]
  | { readonly [key: string]: OfficialWorkflowTemplateJsonValue };

export const officialWorkflowTemplateJsonValueSchema: z.ZodType<OfficialWorkflowTemplateJsonValue> =
  z.lazy(() => {
    return z.union([
      z.null(),
      z.boolean(),
      z.number().safe(),
      z.string(),
      officialWorkflowParameterReferenceSchema,
      z.array(officialWorkflowTemplateJsonValueSchema),
      z.record(z.string(), officialWorkflowTemplateJsonValueSchema),
    ]);
  });

const templatedStringSchema = z.union([
  z.string(),
  officialWorkflowParameterReferenceSchema,
]);
const templatedIntegerSchema = z.union([
  z.number().int().safe(),
  officialWorkflowParameterReferenceSchema,
]);

export const officialWorkflowScheduleTemplateSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("cron"),
        cronExpression: templatedStringSchema,
        timezone: templatedStringSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("loop"),
        intervalSeconds: templatedIntegerSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("once"),
        atTime: templatedStringSchema,
        timezone: templatedStringSchema,
      })
      .strict(),
  ],
);

const officialWorkflowScheduleDesiredStateSchema = z
  .object({
    kind: z.literal("schedule"),
    schedule: officialWorkflowScheduleTemplateSchema,
    autonomyBudget: templatedIntegerSchema.optional(),
  })
  .strict();

const officialWorkflowEventDesiredStateSchema = z
  .object({
    kind: z.literal("event"),
    eventType: automationEventTypeSchema,
    eventConfig: officialWorkflowTemplateJsonValueSchema.optional(),
    autonomyBudget: templatedIntegerSchema.optional(),
  })
  .strict();

export const officialWorkflowBlueprintDesiredStateSchema = z.discriminatedUnion(
  "kind",
  [
    officialWorkflowScheduleDesiredStateSchema,
    officialWorkflowEventDesiredStateSchema,
  ],
);
export type OfficialWorkflowBlueprintDesiredState = z.infer<
  typeof officialWorkflowBlueprintDesiredStateSchema
>;

// P0 reserves a strict Official-only runtime boundary without introducing any
// later-slice runtime capability. Unknown settings fail closed until their
// owning slice lands.
export type OfficialWorkflowRuntimeSettings = Readonly<Record<string, never>>;
export const officialWorkflowRuntimeSettingsSchema: z.ZodType<OfficialWorkflowRuntimeSettings> =
  z.object({}).strict();

export const officialWorkflowBlueprintSchema = z
  .object({
    key: officialWorkflowBlueprintKeySchema,
    parameters: z.array(officialWorkflowInstallationParameterSchema),
    desiredState: officialWorkflowBlueprintDesiredStateSchema,
    runtime: officialWorkflowRuntimeSettingsSchema,
  })
  .strict();
export type OfficialWorkflowBlueprint = z.infer<
  typeof officialWorkflowBlueprintSchema
>;

export const officialWorkflowFileSchema = z
  .object({
    path: z.string().min(1).max(256),
    content: z.string(),
  })
  .strict();

export const officialWorkflowExecutableSchema = z
  .object({
    displayName: z.string().min(1).max(256),
    description: z.string().min(1).max(1024),
    instruction: z.string().max(5 * 1024 * 1024),
    files: z.array(officialWorkflowFileSchema).max(500),
  })
  .strict();
export type OfficialWorkflowExecutable = z.infer<
  typeof officialWorkflowExecutableSchema
>;

export const officialWorkflowPresentationSchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    coverImageUrl: z.url().optional(),
    order: z.number().int().safe().optional(),
    marketingCopy: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type OfficialWorkflowPresentation = z.infer<
  typeof officialWorkflowPresentationSchema
>;

const activeOfficialWorkflowSourceDefinitionSchema = z
  .object({
    name: workflowNameSchema,
    lifecycle: z.literal("active"),
    workflow: officialWorkflowExecutableSchema,
    blueprints: z.array(officialWorkflowBlueprintSchema),
    presentation: officialWorkflowPresentationSchema,
  })
  .strict();

const retiredOfficialWorkflowSourceDefinitionSchema = z
  .object({
    name: workflowNameSchema,
    lifecycle: z.literal("retired"),
    presentation: officialWorkflowPresentationSchema,
  })
  .strict();

export const officialWorkflowSourceDefinitionSchema = z.discriminatedUnion(
  "lifecycle",
  [
    activeOfficialWorkflowSourceDefinitionSchema,
    retiredOfficialWorkflowSourceDefinitionSchema,
  ],
);
export type OfficialWorkflowSourceDefinition = z.infer<
  typeof officialWorkflowSourceDefinitionSchema
>;

export const officialWorkflowSourceCatalogSchema = z
  .object({
    schemaVersion: z.literal(OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION),
    definitions: z.array(officialWorkflowSourceDefinitionSchema),
  })
  .strict();
export type OfficialWorkflowSourceCatalog = z.infer<
  typeof officialWorkflowSourceCatalogSchema
>;

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const officialWorkflowArtifactReferenceSchema = z
  .object({
    storageName: z.string().min(1).max(256),
    storageId: z.string().uuid(),
    storageVersion: fingerprintSchema,
  })
  .strict();
export type OfficialWorkflowArtifactReference = z.infer<
  typeof officialWorkflowArtifactReferenceSchema
>;

export const officialWorkflowAcceptedBlueprintSchema =
  officialWorkflowBlueprintSchema.extend({ fingerprint: fingerprintSchema });
export type OfficialWorkflowAcceptedBlueprint = z.infer<
  typeof officialWorkflowAcceptedBlueprintSchema
>;

export const officialWorkflowDefinitionRevisionPayloadSchema = z
  .object({
    schemaVersion: z.literal(OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION),
    name: workflowNameSchema,
    revision: fingerprintSchema,
    workflow: officialWorkflowExecutableSchema,
    blueprints: z.array(officialWorkflowAcceptedBlueprintSchema),
  })
  .strict();
export type OfficialWorkflowDefinitionRevisionPayload = z.infer<
  typeof officialWorkflowDefinitionRevisionPayloadSchema
>;

export const officialWorkflowAcceptedDefinitionSchema = z
  .object({
    name: workflowNameSchema,
    lifecycle: officialWorkflowLifecycleSchema,
    revision: fingerprintSchema,
    artifact: officialWorkflowArtifactReferenceSchema,
    blueprints: z.array(officialWorkflowAcceptedBlueprintSchema),
    releasedBlueprintKeys: z.array(officialWorkflowBlueprintKeySchema),
    presentation: officialWorkflowPresentationSchema,
  })
  .strict();
export type OfficialWorkflowAcceptedDefinition = z.infer<
  typeof officialWorkflowAcceptedDefinitionSchema
>;

export const officialWorkflowCatalogReleasePayloadSchema = z
  .object({
    schemaVersion: z.literal(OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION),
    definitions: z.array(officialWorkflowAcceptedDefinitionSchema),
  })
  .strict();
export type OfficialWorkflowCatalogReleasePayload = z.infer<
  typeof officialWorkflowCatalogReleasePayloadSchema
>;

export const officialWorkflowCatalogDiagnosticCodeSchema = z.enum([
  "invalid-candidate",
  "duplicate-definition-name",
  "duplicate-blueprint-key",
  "duplicate-parameter-key",
  "invalid-parameter-declaration",
  "invalid-blueprint-configuration",
  "non-canonical-value",
  "missing-released-definition",
  "unknown-retired-definition",
  "artifact-preparation-failed",
  "artifact-registration-failed",
  "activation-conflict",
]);
export type OfficialWorkflowCatalogDiagnosticCode = z.infer<
  typeof officialWorkflowCatalogDiagnosticCodeSchema
>;

export const officialWorkflowCatalogDiagnosticSchema = z
  .object({
    code: officialWorkflowCatalogDiagnosticCodeSchema,
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    definitionName: workflowNameSchema.optional(),
    blueprintKey: officialWorkflowBlueprintKeySchema.optional(),
  })
  .strict();
export type OfficialWorkflowCatalogDiagnostic = z.infer<
  typeof officialWorkflowCatalogDiagnosticSchema
>;

export const officialWorkflowCatalogSyncResponseSchema = z
  .object({
    outcome: z.enum(["accepted", "unchanged", "rejected"]),
    releaseId: fingerprintSchema.nullable(),
    diagnostics: z.array(officialWorkflowCatalogDiagnosticSchema),
  })
  .strict();
export type OfficialWorkflowCatalogSyncResponse = z.infer<
  typeof officialWorkflowCatalogSyncResponseSchema
>;

export const officialWorkflowAcceptedRevisionSchema = z
  .object({
    definition: officialWorkflowDefinitionRevisionPayloadSchema,
    artifact: officialWorkflowArtifactReferenceSchema,
  })
  .strict();
export type OfficialWorkflowAcceptedRevision = z.infer<
  typeof officialWorkflowAcceptedRevisionSchema
>;
