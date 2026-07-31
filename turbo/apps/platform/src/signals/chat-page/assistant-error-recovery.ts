import { command, computed, type Command, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type {
  ModelProviderFramework,
  ModelProviderResponse,
  OrgModelPoliciesResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";
import { resetPersonalCodexSubscriptionUsage$ } from "../zero-page/settings/personal-model-providers.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import type { SendMessageOptions } from "./chat-thread-signals.ts";

export type AssistantErrorRecoveryKind = "usage-limit" | "model-capacity";
export type AssistantErrorRecoveryScope = "framework" | "model";
export type AssistantErrorRecoveryWindow =
  | "five-hour"
  | "weekly"
  | "model"
  | "unknown";

export interface AssistantErrorRecovery {
  readonly sourceEventId: string;
  readonly providerMessage: string;
  readonly kind: AssistantErrorRecoveryKind;
  readonly framework: ModelProviderFramework;
  readonly scope: AssistantErrorRecoveryScope;
  readonly limitWindow: AssistantErrorRecoveryWindow | null;
  readonly retryAt: string | null;
  readonly retryLabel: string | null;
  readonly retryHint: "after-reset" | "few-minutes";
  readonly actions: {
    readonly tryAgain: {
      readonly notBefore: string | null;
    };
    readonly selectModel: {
      readonly allowedFrameworks: readonly ModelProviderFramework[];
      readonly excludedModel: string | null;
    };
    readonly resetAndTryAgain: {
      readonly resetsRemaining: number;
    } | null;
  };
}

interface ClassifiedAssistantError {
  readonly sourceEventId: string;
  readonly providerMessage: string;
  readonly kind: AssistantErrorRecoveryKind;
  readonly framework: ModelProviderFramework;
  readonly scope: AssistantErrorRecoveryScope;
  readonly limitWindow: AssistantErrorRecoveryWindow | null;
  readonly retryLabel: string | null;
}

interface SubscriptionReset {
  readonly resetAt: string | null;
  readonly limitWindow: AssistantErrorRecoveryWindow;
}

type SendMessageCommand = Command<
  Promise<boolean>,
  [string, SendMessageOptions | undefined, AbortSignal]
>;

const ALL_FRAMEWORKS = ["claude-code", "codex"] as const;

function normalizedProviderMessage(error: string): string {
  return error.replace(/\s+/gu, " ").trim();
}

function resetLabelFromProviderMessage(error: string): string | null {
  const match = error.match(/\b(?:resets?|try again at)\s+(.+)$/iu);
  return match?.[1]?.trim().replace(/[.!]+$/u, "") ?? null;
}

function claudeLimitWindow(error: string): AssistantErrorRecoveryWindow | null {
  if (/\bweekly\b/iu.test(error)) {
    return "weekly";
  }
  if (/\b(?:session|5[- ]hour)\b/iu.test(error)) {
    return "five-hour";
  }
  if (/\b(?:opus|sonnet|haiku)\b/iu.test(error)) {
    return "model";
  }
  return null;
}

function isClaudeUsageLimit(error: string): boolean {
  return (
    /you(?:'|’)ve hit your (?:session|weekly|5[- ]hour|opus(?:\s+[\w.-]+)?|sonnet(?:\s+[\w.-]+)?|haiku(?:\s+[\w.-]+)?) limit\b/iu.test(
      error,
    ) || /\bclaude(?: code)? (?:rate|usage) limit reached\b/iu.test(error)
  );
}

function classifyAssistantError(
  event: EnrichedChatEvent,
  error: string,
): ClassifiedAssistantError | null {
  const normalized = normalizedProviderMessage(error);
  const retryLabel = resetLabelFromProviderMessage(normalized);

  if (
    /selected model is at capacity\.? please try a different model/iu.test(
      normalized,
    )
  ) {
    return {
      sourceEventId: event.id,
      providerMessage: error,
      kind: "model-capacity",
      framework: "codex",
      scope: "model",
      limitWindow: null,
      retryLabel: null,
    };
  }

  if (
    /\bclaude\b.*\b(?:is overloaded|overloaded|at capacity)\b/iu.test(
      normalized,
    ) ||
    /\b529\b.*\boverload/iu.test(normalized) ||
    /\boverloaded_error\b/iu.test(normalized)
  ) {
    return {
      sourceEventId: event.id,
      providerMessage: error,
      kind: "model-capacity",
      framework: "claude-code",
      scope: "model",
      limitWindow: null,
      retryLabel: null,
    };
  }

  if (/you(?:'|’)ve hit your usage limit\b/iu.test(normalized)) {
    const modelScoped = /\busage limit for\b/iu.test(normalized);
    return {
      sourceEventId: event.id,
      providerMessage: error,
      kind: "usage-limit",
      framework: "codex",
      scope: modelScoped ? "model" : "framework",
      limitWindow: modelScoped ? "model" : "unknown",
      retryLabel,
    };
  }

  if (isClaudeUsageLimit(normalized)) {
    const limitWindow = claudeLimitWindow(normalized) ?? "unknown";
    return {
      sourceEventId: event.id,
      providerMessage: error,
      kind: "usage-limit",
      framework: "claude-code",
      scope: limitWindow === "model" ? "model" : "framework",
      limitWindow,
      retryLabel,
    };
  }

  return null;
}

function isRenderableAssistantEvent(event: EnrichedChatEvent): boolean {
  const hasAttachments =
    "attachFiles" in event && (event.attachFiles?.length ?? 0) > 0;
  return (
    Boolean(event.content) ||
    event.blocks.length > 0 ||
    hasAttachments ||
    event.eventType === "input.rejected" ||
    event.eventType === "output.error" ||
    event.eventType === "run.failed" ||
    event.eventType === "run.cancelled"
  );
}

function latestAssistantRecoveryCandidate(
  groups: readonly ChatEventGroup[],
): ClassifiedAssistantError | null {
  const group = groups.at(-1);
  if (group?.role !== "assistant") {
    return null;
  }

  let event: EnrichedChatEvent | undefined;
  for (let index = group.events.length - 1; index >= 0; index -= 1) {
    const candidate = group.events[index];
    if (candidate && isRenderableAssistantEvent(candidate)) {
      event = candidate;
      break;
    }
  }
  if (
    event === undefined ||
    (event.eventType !== "output.error" && event.eventType !== "run.failed") ||
    !event.error
  ) {
    return null;
  }
  return classifyAssistantError(event, event.error);
}

function exhaustedUsageWindow(provider: ModelProviderResponse): {
  readonly limitWindow: "five-hour" | "weekly";
  readonly resetAt: string | null;
} | null {
  const usage = provider.subscriptionUsage;
  if (!usage) {
    return null;
  }
  const windows = [
    { limitWindow: "five-hour" as const, value: usage.fiveHour },
    { limitWindow: "weekly" as const, value: usage.weekly },
  ];
  const exhausted = windows.find(({ value }) => {
    return (
      value !== null &&
      (value.remainingPercent === 0 ||
        (value.usedPercent !== null && value.usedPercent >= 100))
    );
  });
  return exhausted
    ? {
        limitWindow: exhausted.limitWindow,
        resetAt: exhausted.value?.resetAt ?? null,
      }
    : null;
}

function providerSubscriptionReset(
  provider: ModelProviderResponse | undefined,
  limitWindow: AssistantErrorRecoveryWindow | null,
): SubscriptionReset | null {
  if (!provider) {
    return null;
  }
  if (limitWindow === "five-hour") {
    return {
      limitWindow,
      resetAt: provider.subscriptionUsage?.fiveHour?.resetAt ?? null,
    };
  }
  if (limitWindow === "weekly") {
    return {
      limitWindow,
      resetAt: provider.subscriptionUsage?.weekly?.resetAt ?? null,
    };
  }
  if (limitWindow === "unknown") {
    return exhaustedUsageWindow(provider);
  }
  return null;
}

function selectedModelPolicy(
  policies: OrgModelPoliciesResponse,
  selectedModel: string | null,
) {
  const model =
    selectedModel ??
    policies.policies.find((policy) => {
      return policy.isDefault;
    })?.model ??
    policies.workspaceDefaultModel;
  return policies.policies.find((policy) => {
    return policy.model === model;
  });
}

function usesPersonalSubscription(
  policies: OrgModelPoliciesResponse,
  selectedModel: string | null,
  providerType: "claude-code-oauth-token" | "codex-oauth-token",
): boolean {
  const policy = selectedModelPolicy(policies, selectedModel);
  return (
    policy?.credentialScope === "member" &&
    policy.defaultProviderType === providerType
  );
}

function allowedFrameworksForRecovery(
  classified: ClassifiedAssistantError,
): readonly ModelProviderFramework[] {
  if (classified.kind !== "usage-limit" || classified.scope === "model") {
    return ALL_FRAMEWORKS;
  }
  return classified.framework === "codex" ? ["claude-code"] : ["codex"];
}

function createAssistantErrorRecoveryComputed(
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
  selectedModel$: Computed<string | null>,
) {
  return computed(async (get): Promise<AssistantErrorRecovery | null> => {
    if (!get(featureSwitch$)[FeatureSwitchKey.ChatErrorRecovery]) {
      return null;
    }
    const classified = latestAssistantRecoveryCandidate(
      await get(visibleRenderedChatGroups$),
    );
    if (!classified) {
      return null;
    }

    let retryAt: string | null = null;
    let limitWindow = classified.limitWindow;
    let resetAndTryAgain: {
      readonly resetsRemaining: number;
    } | null = null;

    if (classified.kind === "usage-limit") {
      const [{ modelProviders }, policies] = await Promise.all([
        get(personalModelProviders$),
        get(orgModelPolicies$),
      ]);
      const providerType =
        classified.framework === "codex"
          ? "codex-oauth-token"
          : "claude-code-oauth-token";
      const provider = modelProviders.find((candidate) => {
        return candidate.type === providerType;
      });
      const usesSubscription = usesPersonalSubscription(
        policies,
        get(selectedModel$),
        providerType,
      );
      const subscriptionReset = usesSubscription
        ? providerSubscriptionReset(provider, classified.limitWindow)
        : null;
      retryAt = subscriptionReset?.resetAt ?? null;
      limitWindow = subscriptionReset?.limitWindow ?? limitWindow;

      if (
        classified.framework === "codex" &&
        classified.scope === "framework" &&
        provider &&
        usesSubscription
      ) {
        const resetsRemaining = provider.subscriptionResetCredits ?? 0;
        if (resetsRemaining > 0) {
          resetAndTryAgain = { resetsRemaining };
        }
      }
    }

    return {
      ...classified,
      limitWindow,
      retryAt,
      retryHint:
        classified.kind === "usage-limit" ? "after-reset" : "few-minutes",
      actions: {
        tryAgain: {
          notBefore: retryAt,
        },
        selectModel: {
          allowedFrameworks: allowedFrameworksForRecovery(classified),
          excludedModel:
            classified.kind === "usage-limit" && classified.scope === "model"
              ? get(selectedModel$)
              : null,
        },
        resetAndTryAgain,
      },
    };
  });
}

export function createAssistantErrorRecoverySignals(deps: {
  readonly visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  readonly selectedModel$: Computed<string | null>;
  readonly sendMessage$: SendMessageCommand;
}) {
  const assistantErrorRecovery$ = createAssistantErrorRecoveryComputed(
    deps.visibleRenderedChatGroups$,
    deps.selectedModel$,
  );
  const retryAssistantError$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const recovery = await get(assistantErrorRecovery$);
      signal.throwIfAborted();
      if (!recovery) {
        return false;
      }
      return await set(deps.sendMessage$, "try again", undefined, signal);
    },
  );
  const resetCodexSubscriptionAndRetry$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const recovery = await get(assistantErrorRecovery$);
      signal.throwIfAborted();
      if (!recovery?.actions.resetAndTryAgain) {
        return false;
      }
      const result = await set(resetPersonalCodexSubscriptionUsage$, signal);
      signal.throwIfAborted();
      if (result.outcome === "noCredit") {
        return false;
      }
      return await set(deps.sendMessage$, "try again", undefined, signal);
    },
  );

  return {
    assistantErrorRecovery$,
    retryAssistantError$,
    resetCodexSubscriptionAndRetry$,
  };
}
