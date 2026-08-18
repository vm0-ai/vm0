import { isDeepStrictEqual } from "node:util";
import { agentComposeApiContentSchema } from "@okouai/api-contracts/contracts/composes";

import { computeComposeVersionId } from "./agent-compose-content";
import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "./agent-execution-plan";

export const AGENT_EXECUTION_PLAN_DIMENSIONS = [
  "danglingOrMissingHeadVersion",
  "unsupportedOrInvalidContent",
  "frameworkOrFallbackDifferences",
  "systemEnvironmentDifferences",
  "runnerGroupPolicyDifferences",
  "runnerProfilePolicyDifferences",
  "agentInstructionsMarkerOrMountDifferences",
  "composeArtifactOrVolumeDifferences",
  "otherLaunchAffectingLegacyFields",
  "unclassifiedContent",
] as const;

export type AgentExecutionPlanDimension =
  (typeof AGENT_EXECUTION_PLAN_DIMENSIONS)[number];

export type AgentExecutionAuthority = "application" | "version_content";

export type AgentExecutionAuthorityClassification =
  | "completeSemanticParity"
  | AgentExecutionPlanDimension
  | "multipleDimensions";

interface AgentExecutionAuthorityInput {
  readonly agentName: string;
  readonly headVersionId: string | null;
  readonly versionId: string | null;
  readonly content: unknown;
}

export interface AgentExecutionAuthorityDecision {
  readonly authority: AgentExecutionAuthority;
  readonly classification: AgentExecutionAuthorityClassification;
  readonly dimensions: readonly AgentExecutionPlanDimension[];
}

type ParsedAgentComposeContent = ReturnType<
  typeof agentComposeApiContentSchema.parse
>;
type ParsedAgentDefinition = ParsedAgentComposeContent["agents"][string];

type ValidatedAgentExecutionPlan =
  | {
      readonly classification: "exception";
      readonly dimension: AgentExecutionPlanDimension;
    }
  | {
      readonly classification: "supported";
      readonly content: ParsedAgentComposeContent;
      readonly activeAgentName: string;
      readonly activeAgent: ParsedAgentDefinition;
    };

function hasInvalidActiveVolumeReference(args: {
  readonly declarations: readonly string[] | undefined;
  readonly volumeNames: ReadonlySet<string>;
}): boolean {
  return (args.declarations ?? []).some((declaration) => {
    const [name, mountPath, extra] = declaration.split(":");
    return (
      extra !== undefined ||
      !name?.trim() ||
      !mountPath?.trim() ||
      !args.volumeNames.has(name.trim())
    );
  });
}

function hasLegacyEnvironmentInfluence(
  environment: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!environment) {
    return false;
  }
  const plan = APPLICATION_OWNED_AGENT_EXECUTION_PLAN.environment;
  const runtimeOverrideKeys = new Set<string>(plan.runtimeOverrideKeys);
  return Object.keys(environment).some((key) => {
    return (
      !runtimeOverrideKeys.has(key) &&
      !plan.legacyRemovedPrefixes.some((prefix) => {
        return key.startsWith(prefix);
      })
    );
  });
}

function isMissingCurrentPlanHead(row: AgentExecutionAuthorityInput): boolean {
  return (
    row.headVersionId === null || row.versionId === null || row.content === null
  );
}

function hasValidCurrentPlanHash(
  row: AgentExecutionAuthorityInput,
): row is AgentExecutionAuthorityInput & {
  readonly headVersionId: string;
  readonly versionId: string;
  readonly content: Record<string, unknown>;
} {
  return (
    row.versionId !== null &&
    row.versionId === row.headVersionId &&
    typeof row.content === "object" &&
    row.content !== null &&
    !Array.isArray(row.content) &&
    computeComposeVersionId(row.content as Record<string, unknown>) ===
      row.versionId
  );
}

function validateAgentExecutionPlanRow(
  row: AgentExecutionAuthorityInput,
): ValidatedAgentExecutionPlan {
  if (isMissingCurrentPlanHead(row)) {
    return {
      classification: "exception",
      dimension: "danglingOrMissingHeadVersion",
    };
  }
  if (!hasValidCurrentPlanHash(row)) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  const parsed = agentComposeApiContentSchema.safeParse(row.content);
  if (!parsed.success) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  if (!isDeepStrictEqual(row.content, parsed.data)) {
    // Zod strips unknown object keys. Any such key could acquire runtime
    // meaning later, so application authority must fail closed.
    return { classification: "exception", dimension: "unclassifiedContent" };
  }
  const firstEntry = Object.entries(parsed.data.agents)[0];
  const activeAgentName = firstEntry?.[0];
  const activeAgent = firstEntry?.[1];
  if (!activeAgentName || !activeAgent) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  if (
    hasInvalidActiveVolumeReference({
      declarations: activeAgent.volumes,
      volumeNames: new Set(Object.keys(parsed.data.volumes ?? {})),
    })
  ) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  return {
    classification: "supported",
    content: parsed.data,
    activeAgentName,
    activeAgent,
  };
}

function semanticAgentExecutionPlanDimensions(
  row: AgentExecutionAuthorityInput,
  validated: Extract<
    ValidatedAgentExecutionPlan,
    { readonly classification: "supported" }
  >,
): Set<AgentExecutionPlanDimension> {
  const dimensions = new Set<AgentExecutionPlanDimension>();
  const plan = APPLICATION_OWNED_AGENT_EXECUTION_PLAN;
  const { activeAgent, activeAgentName, content } = validated;
  // Selected providers supply the same effective framework to both plans.
  // Compare only the version value that remains capable of acting as fallback.
  if (activeAgent.framework !== plan.framework.fallback) {
    dimensions.add("frameworkOrFallbackDifferences");
  }
  if (hasLegacyEnvironmentInfluence(activeAgent.environment)) {
    dimensions.add("systemEnvironmentDifferences");
  }
  if (activeAgent.experimental_runner !== undefined) {
    dimensions.add("runnerGroupPolicyDifferences");
  }
  if (
    activeAgent.experimental_profile !== undefined &&
    activeAgent.experimental_profile !== plan.runner.profile.fallback
  ) {
    dimensions.add("runnerProfilePolicyDifferences");
  }
  if (
    plan.instructions.enabled &&
    (activeAgent.instructions === undefined ||
      activeAgentName !== row.agentName)
  ) {
    dimensions.add("agentInstructionsMarkerOrMountDifferences");
  }
  if (
    (content.artifacts?.length ?? 0) > 0 ||
    (activeAgent.volumes?.length ?? 0) > 0
  ) {
    dimensions.add("composeArtifactOrVolumeDifferences");
  }
  if (activeAgentName !== row.agentName) {
    dimensions.add("otherLaunchAffectingLegacyFields");
  }
  return dimensions;
}

export function classifyAgentExecutionAuthority(
  row: AgentExecutionAuthorityInput,
): AgentExecutionAuthorityDecision {
  const validated = validateAgentExecutionPlanRow(row);
  const dimensions =
    validated.classification === "exception"
      ? new Set<AgentExecutionPlanDimension>([validated.dimension])
      : semanticAgentExecutionPlanDimensions(row, validated);
  const orderedDimensions = AGENT_EXECUTION_PLAN_DIMENSIONS.filter(
    (dimension) => {
      return dimensions.has(dimension);
    },
  );
  if (orderedDimensions.length === 0) {
    return {
      authority: "application",
      classification: "completeSemanticParity",
      dimensions: orderedDimensions,
    };
  }
  return {
    authority: "version_content",
    classification:
      orderedDimensions.length === 1
        ? orderedDimensions[0]!
        : "multipleDimensions",
    dimensions: orderedDimensions,
  };
}
