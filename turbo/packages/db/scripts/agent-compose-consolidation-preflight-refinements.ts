import { isDeepStrictEqual } from "node:util";
import { MODEL_PROVIDER_TYPES } from "@okouai/api-contracts/contracts/model-providers";
import { agentComposeApiContentSchema } from "@okouai/api-contracts/contracts/composes";
import {
  extractVariableReferences,
  extractVariableReferencesFromString,
  expandVariablesInString,
  isSupportedFramework,
} from "@okouai/core";
import { computeComposeVersionId } from "../../../apps/api/src/signals/services/agent-compose-content";
import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "../../../apps/api/src/signals/services/agent-execution-plan";
import {
  fingerprintSortedSet,
  type SetFingerprint,
} from "./agent-compose-consolidation-preflight-fingerprint";
import { isExactHistoricalProductBuilderCandidate } from "./agent-compose-consolidation-preflight-historical-product-builder";

export const ENVIRONMENT_PRIMARY_CLASSES = [
  "variableReferenceOnly",
  "secretReferenceOnly",
  "mixedVariableSecretReferenceOnly",
  "containsLiteralRuntimeValue",
  "malformedOrUnsupportedTemplate",
  "unclassifiedValueShape",
] as const;

export type EnvironmentPrimaryClass =
  (typeof ENVIRONMENT_PRIMARY_CLASSES)[number];

/** Transition-only #28056 output classes; removed by #26938 Stage 8. */
export const HISTORICAL_PRODUCT_BUILDER_ORIGIN_CLASSES = [
  "exactHistoricalProductBuilder",
  "referenceOnlyButUnproven",
  "literalOrOtherUnproven",
] as const;

export type HistoricalProductBuilderOriginClass =
  (typeof HISTORICAL_PRODUCT_BUILDER_ORIGIN_CLASSES)[number];

export const ENVIRONMENT_OVERLAP_DIMENSIONS = [
  "officialModelProviderBindingCollision",
  "multipleSurvivingLegacyEntries",
  "mixedSourceOrValueSemantics",
] as const;

export type EnvironmentOverlapDimension =
  (typeof ENVIRONMENT_OVERLAP_DIMENSIONS)[number];

/**
 * Priority is significant and intentionally mirrors runtime resolution:
 * non-object content (whose hash cannot be computed), computable hash drift,
 * a fully runtime-resolvable singular definition, active-definition selection,
 * framework, environment, Storage shapes, then the remaining schema-invalid
 * surface.
 */
export const UNSUPPORTED_PRIMARY_REASONS = [
  "contentHashMismatch",
  "nonObjectNullOrArrayContent",
  "runtimeResolvableLegacySingularAgent",
  "missingOrAmbiguousActiveAgentDefinition",
  "unsupportedOrMissingFramework",
  "invalidEnvironmentContainerOrTemplateType",
  "invalidActiveVolumeOrArtifactShapeOrReference",
  "otherSchemaInvalidOrRuntimeUnresolvableContent",
] as const;

export type UnsupportedPrimaryReason =
  (typeof UNSUPPORTED_PRIMARY_REASONS)[number];

export const UNCLASSIFIED_PRIMARY_CLASSES = [
  "runtimeIgnoredOnly",
  "inactiveAgentOnly",
  "activeAgentOrTopLevelRuntimeReachable",
  "mixedLocations",
  "stillUnknown",
] as const;

export type UnclassifiedPrimaryClass =
  (typeof UNCLASSIFIED_PRIMARY_CLASSES)[number];

export const ACTIVITY_BUCKETS = [
  "within7Days",
  "over7Through30Days",
  "over30Through90Days",
  "over90Days",
  "noAttributedRun",
] as const;

export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

export interface ExceptionRefinementInventoryRow {
  readonly id: string;
  readonly agentName: string;
  readonly headVersionId: string | null;
  readonly versionId: string | null;
  readonly content: unknown;
  readonly activitySnapshotTime: Date;
  readonly latestAttributedRunAt: Date | null;
  readonly activeNonterminalRun: boolean;
  readonly currentHeadEverExercised: boolean;
  readonly unknownRunStatus: boolean;
}

export interface SetComparison {
  readonly expected: SetFingerprint;
  readonly observed: SetFingerprint;
  readonly classification: "exact" | "drift";
}

function setComparison(
  domain: string,
  expected: readonly string[],
  observed: readonly string[],
  cardinalityAware: boolean,
): SetComparison {
  const expectedFingerprint = fingerprintSortedSet(
    `${domain}:expected`,
    expected,
  );
  const observedFingerprint = fingerprintSortedSet(
    `${domain}:expected`,
    observed,
  );
  const exactSet =
    expectedFingerprint.count === observedFingerprint.count &&
    expectedFingerprint.digest === observedFingerprint.digest;
  const exactCardinality =
    !cardinalityAware ||
    (expected.length === expectedFingerprint.count &&
      observed.length === observedFingerprint.count &&
      expected.length === observed.length);
  return {
    expected: expectedFingerprint,
    observed: observedFingerprint,
    classification: exactSet && exactCardinality ? "exact" : "drift",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function activeRawAgent(content: Record<string, unknown>): unknown {
  if (content.agent) return content.agent;
  const agents = content.agents;
  if (!isRecord(agents)) return undefined;
  const firstKey = Object.keys(agents)[0];
  return firstKey ? agents[firstKey] : undefined;
}

function validEnvironment(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.values(value).every((entry) => {
        return typeof entry === "string";
      }))
  );
}

function validReferencedVolumeConfig(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    (value.optional === undefined || typeof value.optional === "boolean")
  );
}

function validReferencedVolumeDeclaration(
  rawVolumes: Record<string, unknown>,
  declaration: string,
): boolean {
  const [name, mountPath, extra] = declaration.split(":");
  if (extra !== undefined || !name?.trim() || !mountPath?.trim()) return false;
  return validReferencedVolumeConfig(rawVolumes[name.trim()]);
}

function validActiveVolumeSurface(
  rawVolumes: unknown,
  declarations: unknown,
): boolean {
  if (declarations === undefined) return true;
  if (
    !Array.isArray(declarations) ||
    !declarations.every((entry) => {
      return typeof entry === "string";
    })
  ) {
    return false;
  }
  if (declarations.length === 0) return true;
  if (!isRecord(rawVolumes)) return false;
  return declarations.every((declaration) => {
    return validReferencedVolumeDeclaration(rawVolumes, declaration);
  });
}

function validArtifactMountPath(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      (value === "${{ working_dir }}" || value.startsWith("/")))
  );
}

function validArtifact(
  value: unknown,
  previouslySeenNames: ReadonlySet<string>,
): value is Record<string, unknown> & { readonly name: string } {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    (value.version === undefined ||
      (typeof value.version === "string" && value.version.length > 0)) &&
    validArtifactMountPath(value.mount_path) &&
    !previouslySeenNames.has(value.name)
  );
}

function validArtifactSurface(artifacts: unknown): boolean {
  if (artifacts === undefined) return true;
  if (!Array.isArray(artifacts)) return false;
  const names = new Set<string>();
  for (const artifact of artifacts) {
    if (!validArtifact(artifact, names)) return false;
    names.add(artifact.name);
  }
  return true;
}

function validVolumeAndArtifactSurface(
  content: Record<string, unknown>,
  activeAgent: Record<string, unknown>,
): boolean {
  return (
    validActiveVolumeSurface(content.volumes, activeAgent.volumes) &&
    validArtifactSurface(content.artifacts)
  );
}

function isRuntimeResolvableSingularContent(
  content: Record<string, unknown>,
): boolean {
  if (!isRecord(content.agent)) return false;
  const agent = content.agent;
  return (
    typeof agent.framework === "string" &&
    isSupportedFramework(agent.framework) &&
    validEnvironment(agent.environment) &&
    validVolumeAndArtifactSurface(content, agent)
  );
}

function unsupportedReason(
  row: ExceptionRefinementInventoryRow,
): UnsupportedPrimaryReason {
  if (!isRecord(row.content)) return "nonObjectNullOrArrayContent";
  if (
    row.versionId === null ||
    row.headVersionId === null ||
    row.versionId !== row.headVersionId ||
    computeComposeVersionId(row.content) !== row.versionId
  ) {
    return "contentHashMismatch";
  }
  if (isRuntimeResolvableSingularContent(row.content)) {
    return "runtimeResolvableLegacySingularAgent";
  }
  const activeAgent = activeRawAgent(row.content);
  if (!isRecord(activeAgent)) {
    return "missingOrAmbiguousActiveAgentDefinition";
  }
  if (
    typeof activeAgent.framework !== "string" ||
    !isSupportedFramework(activeAgent.framework)
  ) {
    return "unsupportedOrMissingFramework";
  }
  if (!validEnvironment(activeAgent.environment)) {
    return "invalidEnvironmentContainerOrTemplateType";
  }
  if (!validVolumeAndArtifactSurface(row.content, activeAgent)) {
    return "invalidActiveVolumeOrArtifactShapeOrReference";
  }
  return "otherSchemaInvalidOrRuntimeUnresolvableContent";
}

const officialModelProviderEnvironmentBindings = new Set(
  Object.values(MODEL_PROVIDER_TYPES).flatMap((provider) => {
    return "envBindings" in provider ? Object.keys(provider.envBindings) : [];
  }),
);

interface EnvironmentClassification {
  readonly primary: EnvironmentPrimaryClass;
  readonly overlaps: ReadonlySet<EnvironmentOverlapDimension>;
}

function survivingLegacyEnvironmentEntries(
  row: ExceptionRefinementInventoryRow,
): [string, string][] | null {
  const parsed = agentComposeApiContentSchema.safeParse(row.content);
  if (!parsed.success || !isDeepStrictEqual(row.content, parsed.data))
    return null;
  const firstEntry = Object.entries(parsed.data.agents)[0];
  const environment = firstEntry?.[1]?.environment;
  if (!environment) return null;
  const plan = APPLICATION_OWNED_AGENT_EXECUTION_PLAN.environment;
  const runtimeOverrideKeys = new Set<string>(plan.runtimeOverrideKeys);
  const entries = Object.entries(environment).filter(([key]) => {
    return (
      !runtimeOverrideKeys.has(key) &&
      !plan.legacyRemovedPrefixes.some((prefix) => {
        return key.startsWith(prefix);
      })
    );
  });
  return entries.length === 0 ? null : entries;
}

interface EnvironmentValueSemantics {
  readonly hasVariableReference: boolean;
  readonly hasSecretReference: boolean;
  readonly hasReferenceOnlyValue: boolean;
  readonly hasLiteralValue: boolean;
  readonly hasMalformedOrUnsupportedValue: boolean;
}

function classifyEnvironmentValue(value: string): EnvironmentValueSemantics {
  const references = extractVariableReferencesFromString(value);
  const variables = Object.fromEntries(
    references
      .filter((reference) => {
        return reference.source === "vars";
      })
      .map((reference) => {
        return [reference.name, ""];
      }),
  );
  const secrets = Object.fromEntries(
    references
      .filter((reference) => {
        return reference.source === "secrets";
      })
      .map((reference) => {
        return [reference.name, ""];
      }),
  );
  const expanded = expandVariablesInString(value, { vars: variables, secrets });
  const hasMalformedOrUnsupportedValue =
    references.some((reference) => {
      return reference.source === "env";
    }) ||
    expanded.result.includes("${{") ||
    expanded.result.includes("}}");
  const hasReferenceOnlyValue =
    !hasMalformedOrUnsupportedValue &&
    references.length > 0 &&
    expanded.result.length === 0;
  return {
    hasVariableReference: references.some((reference) => {
      return reference.source === "vars";
    }),
    hasSecretReference: references.some((reference) => {
      return reference.source === "secrets";
    }),
    hasReferenceOnlyValue,
    hasLiteralValue: !hasMalformedOrUnsupportedValue && !hasReferenceOnlyValue,
    hasMalformedOrUnsupportedValue,
  };
}

function aggregateEnvironmentValueSemantics(
  entries: readonly [string, string][],
): EnvironmentValueSemantics {
  let hasVariableReference = false;
  let hasSecretReference = false;
  let hasReferenceOnlyValue = false;
  let hasLiteralValue = false;
  let hasMalformedOrUnsupportedValue = false;

  for (const [, value] of entries) {
    const valueSemantics = classifyEnvironmentValue(value);
    hasVariableReference ||= valueSemantics.hasVariableReference;
    hasSecretReference ||= valueSemantics.hasSecretReference;
    hasReferenceOnlyValue ||= valueSemantics.hasReferenceOnlyValue;
    hasLiteralValue ||= valueSemantics.hasLiteralValue;
    hasMalformedOrUnsupportedValue ||=
      valueSemantics.hasMalformedOrUnsupportedValue;
  }
  return {
    hasVariableReference,
    hasSecretReference,
    hasReferenceOnlyValue,
    hasLiteralValue,
    hasMalformedOrUnsupportedValue,
  };
}

function environmentOverlaps(
  entries: readonly [string, string][],
  semantics: EnvironmentValueSemantics,
): ReadonlySet<EnvironmentOverlapDimension> {
  const overlaps = new Set<EnvironmentOverlapDimension>();
  if (
    entries.some(([key]) => {
      return officialModelProviderEnvironmentBindings.has(key);
    })
  ) {
    overlaps.add("officialModelProviderBindingCollision");
  }
  if (entries.length > 1) overlaps.add("multipleSurvivingLegacyEntries");

  if (
    (semantics.hasVariableReference && semantics.hasSecretReference) ||
    (semantics.hasReferenceOnlyValue && semantics.hasLiteralValue) ||
    semantics.hasMalformedOrUnsupportedValue
  ) {
    overlaps.add("mixedSourceOrValueSemantics");
  }
  return overlaps;
}

function environmentPrimary(
  semantics: EnvironmentValueSemantics,
): EnvironmentPrimaryClass {
  if (semantics.hasMalformedOrUnsupportedValue) {
    return "malformedOrUnsupportedTemplate";
  }
  if (semantics.hasLiteralValue) {
    return "containsLiteralRuntimeValue";
  }
  if (semantics.hasVariableReference && semantics.hasSecretReference) {
    return "mixedVariableSecretReferenceOnly";
  }
  if (semantics.hasVariableReference) {
    return "variableReferenceOnly";
  }
  if (semantics.hasSecretReference) {
    return "secretReferenceOnly";
  }
  return "unclassifiedValueShape";
}

function environmentClassification(
  row: ExceptionRefinementInventoryRow,
): EnvironmentClassification {
  const entries = survivingLegacyEnvironmentEntries(row);
  if (!entries) {
    return { primary: "unclassifiedValueShape", overlaps: new Set() };
  }
  const semantics = aggregateEnvironmentValueSemantics(entries);
  return {
    primary: environmentPrimary(semantics),
    overlaps: environmentOverlaps(entries, semantics),
  };
}

/** Transition-only #28056 classifier adapter; removed by #26938 Stage 8. */
function historicalProductBuilderOrigin(
  row: ExceptionRefinementInventoryRow,
): HistoricalProductBuilderOriginClass {
  if (isExactHistoricalProductBuilderCandidate(row)) {
    return "exactHistoricalProductBuilder";
  }
  const primary = environmentClassification(row).primary;
  if (
    primary === "variableReferenceOnly" ||
    primary === "secretReferenceOnly" ||
    primary === "mixedVariableSecretReferenceOnly"
  ) {
    return "referenceOnlyButUnproven";
  }
  return "literalOrOtherUnproven";
}

type StrippedDisposition = "ignored" | "inactive" | "reachable" | "unknown";

interface StrippedNode {
  readonly path: readonly string[];
  readonly value: unknown;
}

function collectStrippedNodes(
  raw: unknown,
  parsed: unknown,
  currentPath: readonly string[] = [],
): StrippedNode[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((value, index) => {
      if (index >= parsed.length) {
        return [{ path: [...currentPath, "[]"], value }];
      }
      return collectStrippedNodes(value, parsed[index], [...currentPath, "[]"]);
    });
  }
  if (!isRecord(raw) || !isRecord(parsed)) return [];
  return Object.entries(raw).flatMap(([key, value]) => {
    const nextPath = [...currentPath, key];
    if (!Object.hasOwn(parsed, key)) return [{ path: nextPath, value }];
    return collectStrippedNodes(value, parsed[key], nextPath);
  });
}

function strippedNodeDisposition(args: {
  readonly node: StrippedNode;
  readonly references: RuntimeAgentReferenceGraph;
}): StrippedDisposition {
  if (
    extractVariableReferences(args.node.value).some((reference) => {
      return reference.source === "vars" || reference.source === "secrets";
    })
  ) {
    // Slack, Telegram, and Teams recursively scan the entire raw JSON.
    return "reachable";
  }
  const [topLevel, agentName] = args.node.path;
  if (topLevel === "agent") return "reachable";
  if (topLevel === "agents") {
    if (!agentName) return "unknown";
    return agentName === args.references.selectedPluralAgentName
      ? "reachable"
      : "inactive";
  }
  if (topLevel === "volumes") {
    const [, volumeName, field] = args.node.path;
    // Storage consumes the legacy raw content rather than the Zod-parsed
    // value. `system` is absent from the API schema but read for every volume
    // referenced by the selected Agent, so stripping it is not proof that it
    // is runtime-ignored. A selected reference wins over inactive references.
    // Only a complete selected-Agent reference graph can prove that an
    // unselected volume is ignored.
    if (field !== "system") return "ignored";
    if (!args.references.selectedReferencesComplete) return "unknown";
    if (args.references.selectedVolumeNames.has(volumeName ?? "")) {
      return "reachable";
    }
    if (args.references.inactiveVolumeNames.has(volumeName ?? "")) {
      return "inactive";
    }
    return "ignored";
  }
  if (topLevel === "artifacts") return "ignored";
  return "unknown";
}

interface VolumeReferences {
  readonly names: ReadonlySet<string>;
  readonly complete: boolean;
}

interface RuntimeAgentReferenceGraph {
  /** Null means the truthy singular definition wins runtime selection. */
  readonly selectedPluralAgentName: string | null;
  readonly selectedVolumeNames: ReadonlySet<string>;
  readonly inactiveVolumeNames: ReadonlySet<string>;
  readonly selectedReferencesComplete: boolean;
}

function volumeReferences(agent: unknown): VolumeReferences {
  if (!isRecord(agent)) return { names: new Set(), complete: false };
  if (agent.volumes === undefined) return { names: new Set(), complete: true };
  if (
    !Array.isArray(agent.volumes) ||
    !agent.volumes.every((declaration) => {
      return typeof declaration === "string";
    })
  ) {
    return { names: new Set(), complete: false };
  }
  const names = new Set<string>();
  for (const declaration of agent.volumes) {
    const [name, mountPath, extra] = declaration.split(":");
    if (extra !== undefined || !name?.trim() || !mountPath?.trim()) {
      return { names, complete: false };
    }
    names.add(name.trim());
  }
  return { names, complete: true };
}

function runtimeAgentReferenceGraph(
  content: Record<string, unknown>,
): RuntimeAgentReferenceGraph {
  const pluralEntries = isRecord(content.agents)
    ? Object.entries(content.agents)
    : [];
  const singularSelected = Boolean(content.agent);
  const selectedEntry = singularSelected ? undefined : pluralEntries[0];
  const selectedAgent = singularSelected ? content.agent : selectedEntry?.[1];
  const inactiveAgents = singularSelected
    ? pluralEntries.map(([, agent]) => {
        return agent;
      })
    : pluralEntries.slice(1).map(([, agent]) => {
        return agent;
      });
  const selected = volumeReferences(selectedAgent);
  const inactiveVolumeNames = new Set<string>();
  for (const inactiveAgent of inactiveAgents) {
    for (const name of volumeReferences(inactiveAgent).names) {
      inactiveVolumeNames.add(name);
    }
  }
  return {
    selectedPluralAgentName: singularSelected
      ? null
      : (selectedEntry?.[0] ?? null),
    selectedVolumeNames: selected.names,
    inactiveVolumeNames,
    selectedReferencesComplete: selected.complete,
  };
}

function unclassifiedPrimary(
  row: ExceptionRefinementInventoryRow,
): UnclassifiedPrimaryClass {
  const parsed = agentComposeApiContentSchema.safeParse(row.content);
  if (
    !parsed.success ||
    !isRecord(row.content) ||
    isDeepStrictEqual(row.content, parsed.data)
  ) {
    return "stillUnknown";
  }
  const references = runtimeAgentReferenceGraph(row.content);
  const dispositions = new Set(
    collectStrippedNodes(row.content, parsed.data).map((node) => {
      return strippedNodeDisposition({ node, references });
    }),
  );
  if (dispositions.size === 0) return "stillUnknown";
  if (dispositions.size > 1) return "mixedLocations";
  const [disposition] = dispositions;
  switch (disposition) {
    case "ignored":
      return "runtimeIgnoredOnly";
    case "inactive":
      return "inactiveAgentOnly";
    case "reachable":
      return "activeAgentOrTopLevelRuntimeReachable";
    case "unknown":
    case undefined:
      return "stillUnknown";
  }
  return "stillUnknown";
}

function activityBucket(
  row: ExceptionRefinementInventoryRow,
): ActivityBucket | null {
  if (row.latestAttributedRunAt === null) return "noAttributedRun";
  const latest = row.latestAttributedRunAt.getTime();
  const snapshot = row.activitySnapshotTime.getTime();
  if (
    !Number.isFinite(latest) ||
    !Number.isFinite(snapshot) ||
    latest > snapshot
  ) {
    return null;
  }
  const age = snapshot - latest;
  const day = 24 * 60 * 60 * 1000;
  if (age <= 7 * day) return "within7Days";
  if (age <= 30 * day) return "over7Through30Days";
  if (age <= 90 * day) return "over30Through90Days";
  return "over90Days";
}

function classifyActivity(args: {
  readonly domain: string;
  readonly ids: readonly string[];
  readonly rowsById: ReadonlyMap<
    string,
    readonly ExceptionRefinementInventoryRow[]
  >;
  readonly failureGates: Set<string>;
}) {
  const bucketIds = Object.fromEntries(
    ACTIVITY_BUCKETS.map((bucket) => {
      return [bucket, [] as string[]];
    }),
  ) as Record<ActivityBucket, string[]>;
  const activeIds: string[] = [];
  const currentHeadIds: string[] = [];
  for (const id of args.ids) {
    const matches = args.rowsById.get(id) ?? [];
    const row = matches.length === 1 ? matches[0] : undefined;
    if (
      !row ||
      typeof row.activeNonterminalRun !== "boolean" ||
      typeof row.currentHeadEverExercised !== "boolean" ||
      typeof row.unknownRunStatus !== "boolean" ||
      !(row.activitySnapshotTime instanceof Date) ||
      !Number.isFinite(row.activitySnapshotTime.getTime()) ||
      (row.latestAttributedRunAt !== null &&
        (!(row.latestAttributedRunAt instanceof Date) ||
          !Number.isFinite(row.latestAttributedRunAt.getTime())))
    ) {
      continue;
    }
    const bucket = activityBucket(row);
    if (bucket) bucketIds[bucket].push(id);
    if (row.activeNonterminalRun) activeIds.push(id);
    if (row.currentHeadEverExercised) currentHeadIds.push(id);
    if (row.unknownRunStatus) {
      args.failureGates.add("agentExecutionPlans.activity.unknownRunStatus");
    }
  }
  const observed = ACTIVITY_BUCKETS.flatMap((bucket) => {
    return bucketIds[bucket];
  });
  const partitionClosure = setComparison(
    `${args.domain}:activity-partition-closure`,
    args.ids,
    observed,
    true,
  );
  if (partitionClosure.classification === "drift") {
    args.failureGates.add("agentExecutionPlans.activity.partitionClosure");
  }
  return {
    latestAttributedRun: {
      ...Object.fromEntries(
        ACTIVITY_BUCKETS.map((bucket) => {
          return [
            bucket,
            fingerprintSortedSet(
              `${args.domain}:activity:${bucket}:agent-ids`,
              bucketIds[bucket],
            ),
          ];
        }),
      ),
      partitionClosure,
    } as Record<ActivityBucket, SetFingerprint> & {
      readonly partitionClosure: SetComparison;
    },
    activeNonterminalRun: fingerprintSortedSet(
      `${args.domain}:activity:active-nonterminal-run:agent-ids`,
      activeIds,
    ),
    currentHeadEverExercised: fingerprintSortedSet(
      `${args.domain}:activity:current-head-ever-exercised:agent-ids`,
      currentHeadIds,
    ),
  };
}

function primaryClassification<Primary extends string>(args: {
  readonly domain: string;
  readonly parentIds: readonly string[];
  readonly primaryClasses: readonly Primary[];
  readonly classify: (row: ExceptionRefinementInventoryRow) => Primary;
  readonly rowsById: ReadonlyMap<
    string,
    readonly ExceptionRefinementInventoryRow[]
  >;
  readonly failureGates: Set<string>;
}) {
  const idsByClass = Object.fromEntries(
    args.primaryClasses.map((primary) => {
      return [primary, [] as string[]];
    }),
  ) as Record<Primary, string[]>;
  for (const id of args.parentIds) {
    const matches = args.rowsById.get(id) ?? [];
    const row = matches.length === 1 ? matches[0] : undefined;
    if (!row) continue;
    idsByClass[args.classify(row)].push(id);
  }
  const observed = args.primaryClasses.flatMap((primary) => {
    return idsByClass[primary];
  });
  const partitionClosure = setComparison(
    `${args.domain}:primary-partition-closure`,
    args.parentIds,
    observed,
    true,
  );
  const unionClosure = setComparison(
    `${args.domain}:primary-union-closure`,
    args.parentIds,
    [...new Set(observed)],
    false,
  );
  if (partitionClosure.classification === "drift") {
    args.failureGates.add(`${args.domain}.primaryPartitionClosure`);
  }
  if (unionClosure.classification === "drift") {
    args.failureGates.add(`${args.domain}.primaryUnionClosure`);
  }
  const primary = Object.fromEntries(
    args.primaryClasses.map((primaryClass) => {
      return [
        primaryClass,
        fingerprintSortedSet(
          `${args.domain}:primary:${primaryClass}:agent-ids`,
          idsByClass[primaryClass],
        ),
      ];
    }),
  ) as Record<Primary, SetFingerprint>;
  const activity = {
    parent: classifyActivity({
      domain: `${args.domain}:parent`,
      ids: args.parentIds,
      rowsById: args.rowsById,
      failureGates: args.failureGates,
    }),
    primary: Object.fromEntries(
      args.primaryClasses.map((primaryClass) => {
        return [
          primaryClass,
          classifyActivity({
            domain: `${args.domain}:primary:${primaryClass}`,
            ids: idsByClass[primaryClass],
            rowsById: args.rowsById,
            failureGates: args.failureGates,
          }),
        ];
      }),
    ),
  } as const;
  return { idsByClass, primary, partitionClosure, unionClosure, activity };
}

export function classifyExceptionRefinements(args: {
  readonly rowsById: ReadonlyMap<
    string,
    readonly ExceptionRefinementInventoryRow[]
  >;
  readonly legacyEnvironmentIds: readonly string[];
  readonly residualEnvironmentIds: readonly string[];
  readonly applicationHistoricalProductBuilderEnvironmentIds: readonly string[];
  readonly unsupportedIds: readonly string[];
  readonly unclassifiedIds: readonly string[];
  readonly failureGates: Set<string>;
}) {
  const environmentOverlaps = Object.fromEntries(
    ENVIRONMENT_OVERLAP_DIMENSIONS.map((dimension) => {
      return [dimension, [] as string[]];
    }),
  ) as Record<EnvironmentOverlapDimension, string[]>;
  const environmentClassifications = new Map<
    string,
    EnvironmentClassification
  >();
  const environment = primaryClassification({
    domain: "agentExecutionPlans.refinements.systemEnvironmentDifferences",
    parentIds: args.legacyEnvironmentIds,
    primaryClasses: ENVIRONMENT_PRIMARY_CLASSES,
    rowsById: args.rowsById,
    failureGates: args.failureGates,
    classify: (row) => {
      const classification = environmentClassification(row);
      environmentClassifications.set(row.id, classification);
      for (const overlap of classification.overlaps) {
        environmentOverlaps[overlap].push(row.id);
      }
      return classification.primary;
    },
  });
  const overlapUnionIds = [
    ...new Set(
      ENVIRONMENT_OVERLAP_DIMENSIONS.flatMap((dimension) => {
        return environmentOverlaps[dimension];
      }),
    ),
  ];
  const expectedOverlapUnionIds = args.legacyEnvironmentIds.filter((id) => {
    return (environmentClassifications.get(id)?.overlaps.size ?? 0) > 0;
  });
  const overlapUnionClosure = setComparison(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences:overlap-union-closure",
    expectedOverlapUnionIds,
    overlapUnionIds,
    false,
  );
  if (overlapUnionClosure.classification === "drift") {
    args.failureGates.add(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.overlapUnionClosure",
    );
  }
  if (environment.primary.unclassifiedValueShape.count > 0) {
    args.failureGates.add(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.unclassifiedValueShape",
    );
  }

  // Transition-only #28056 evidence partition; removed by #26938 Stage 8.
  const historicalProductBuilderOriginClassification = primaryClassification({
    domain:
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin",
    parentIds: args.legacyEnvironmentIds,
    primaryClasses: HISTORICAL_PRODUCT_BUILDER_ORIGIN_CLASSES,
    rowsById: args.rowsById,
    failureGates: args.failureGates,
    classify: historicalProductBuilderOrigin,
  });
  const originAssignments = HISTORICAL_PRODUCT_BUILDER_ORIGIN_CLASSES.flatMap(
    (primaryClass) => {
      return historicalProductBuilderOriginClassification.idsByClass[
        primaryClass
      ];
    },
  );
  const originAssignmentCounts = new Map<string, number>();
  for (const id of originAssignments) {
    originAssignmentCounts.set(id, (originAssignmentCounts.get(id) ?? 0) + 1);
  }
  const duplicateOriginIds = [...originAssignmentCounts]
    .filter(([, count]) => {
      return count > 1;
    })
    .map(([id]) => {
      return id;
    });
  const originDisjointnessClosure = setComparison(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:primary-disjointness-closure",
    [],
    duplicateOriginIds,
    false,
  );
  if (originDisjointnessClosure.classification === "drift") {
    args.failureGates.add(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin.primaryDisjointnessClosure",
    );
  }

  const exactHistoricalProductBuilderIds =
    historicalProductBuilderOriginClassification.idsByClass
      .exactHistoricalProductBuilder;
  const unprovenHistoricalProductBuilderIds = [
    ...historicalProductBuilderOriginClassification.idsByClass
      .referenceOnlyButUnproven,
    ...historicalProductBuilderOriginClassification.idsByClass
      .literalOrOtherUnproven,
  ];
  const legacyEnvironmentLineage = fingerprintSortedSet(
    "agent-execution-plans:systemEnvironmentDifferences:agent-ids",
    args.legacyEnvironmentIds,
  );
  const applicationAuthorityMembershipLineageClosure = setComparison(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:application-authority-membership-lineage-closure",
    exactHistoricalProductBuilderIds,
    args.applicationHistoricalProductBuilderEnvironmentIds,
    true,
  );
  const residualEnvironmentMembershipLineageClosure = setComparison(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:residual-environment-membership-lineage-closure",
    unprovenHistoricalProductBuilderIds,
    args.residualEnvironmentIds,
    true,
  );
  const authorityPartitionClosure = setComparison(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:authority-partition-closure",
    args.legacyEnvironmentIds,
    [
      ...args.applicationHistoricalProductBuilderEnvironmentIds,
      ...args.residualEnvironmentIds,
    ],
    true,
  );
  const residualEnvironmentSet = new Set(args.residualEnvironmentIds);
  const authorityIntersectionIds =
    args.applicationHistoricalProductBuilderEnvironmentIds.filter((id) => {
      return residualEnvironmentSet.has(id);
    });
  const authorityDisjointnessClosure = setComparison(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:authority-disjointness-closure",
    [],
    authorityIntersectionIds,
    true,
  );
  for (const [name, closure] of [
    [
      "applicationAuthorityMembershipLineageClosure",
      applicationAuthorityMembershipLineageClosure,
    ],
    [
      "residualEnvironmentMembershipLineageClosure",
      residualEnvironmentMembershipLineageClosure,
    ],
    ["authorityPartitionClosure", authorityPartitionClosure],
    ["authorityDisjointnessClosure", authorityDisjointnessClosure],
  ] as const) {
    if (closure.classification === "drift") {
      args.failureGates.add(
        `agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin.${name}`,
      );
    }
  }

  const unsupported = primaryClassification({
    domain: "agentExecutionPlans.refinements.unsupportedOrInvalidContent",
    parentIds: args.unsupportedIds,
    primaryClasses: UNSUPPORTED_PRIMARY_REASONS,
    rowsById: args.rowsById,
    failureGates: args.failureGates,
    classify: unsupportedReason,
  });
  if (
    unsupported.primary.otherSchemaInvalidOrRuntimeUnresolvableContent.count > 0
  ) {
    args.failureGates.add(
      "agentExecutionPlans.refinements.unsupportedOrInvalidContent.otherSchemaInvalidOrRuntimeUnresolvableContent",
    );
  }

  const unclassified = primaryClassification({
    domain: "agentExecutionPlans.refinements.unclassifiedContent",
    parentIds: args.unclassifiedIds,
    primaryClasses: UNCLASSIFIED_PRIMARY_CLASSES,
    rowsById: args.rowsById,
    failureGates: args.failureGates,
    classify: unclassifiedPrimary,
  });
  if (unclassified.primary.stillUnknown.count > 0) {
    args.failureGates.add(
      "agentExecutionPlans.refinements.unclassifiedContent.stillUnknown",
    );
  }

  return {
    systemEnvironmentDifferences: {
      primary: environment.primary,
      overlaps: Object.fromEntries(
        ENVIRONMENT_OVERLAP_DIMENSIONS.map((dimension) => {
          return [
            dimension,
            fingerprintSortedSet(
              `agentExecutionPlans.refinements.systemEnvironmentDifferences:overlap:${dimension}:agent-ids`,
              environmentOverlaps[dimension],
            ),
          ];
        }),
      ) as Record<EnvironmentOverlapDimension, SetFingerprint>,
      primaryPartitionClosure: environment.partitionClosure,
      primaryUnionClosure: environment.unionClosure,
      overlapUnionClosure,
      activity: environment.activity,
      /** Transition-only #28056 and #28070 output; removed by #26938 Stage 8. */
      historicalProductBuilderOrigin: {
        legacyEnvironmentLineage,
        primary: historicalProductBuilderOriginClassification.primary,
        primaryPartitionClosure:
          historicalProductBuilderOriginClassification.partitionClosure,
        primaryDisjointnessClosure: originDisjointnessClosure,
        primaryUnionClosure:
          historicalProductBuilderOriginClassification.unionClosure,
        applicationAuthorityMembershipLineageClosure,
        residualEnvironmentMembershipLineageClosure,
        authorityPartitionClosure,
        authorityDisjointnessClosure,
        activity: historicalProductBuilderOriginClassification.activity,
      },
    },
    unsupportedOrInvalidContent: {
      primary: unsupported.primary,
      primaryPartitionClosure: unsupported.partitionClosure,
      primaryUnionClosure: unsupported.unionClosure,
      activity: unsupported.activity,
    },
    unclassifiedContent: {
      primary: unclassified.primary,
      primaryPartitionClosure: unclassified.partitionClosure,
      primaryUnionClosure: unclassified.unionClosure,
      activity: unclassified.activity,
    },
  };
}
