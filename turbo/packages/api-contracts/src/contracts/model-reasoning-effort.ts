import { z } from "zod";

import { normalizeBuiltInModelId } from "./model-providers";

const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const CLAUDE_CODE_EFFORTS = [
  "low",
  "medium",
  "high",
  "extra",
  "max",
  "ultracode",
] as const;

export const reasoningEffortSchema = z.union([
  z.enum(CODEX_REASONING_EFFORTS),
  z.enum(CLAUDE_CODE_EFFORTS),
]);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** Native CLI choices, further restricted by the selected model. */
export function getModelReasoningEfforts(
  model: string | null | undefined,
): readonly ReasoningEffort[] {
  const bareModel = model?.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  switch (normalizeBuiltInModelId(bareModel ?? "")) {
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
    case "gpt-6-astra":
      return CODEX_REASONING_EFFORTS;
    case "gpt-5.5":
      return ["low", "medium", "high", "xhigh"];
    case "claude-fable-5-1":
    case "claude-opus-5":
    case "claude-opus-4-8":
    case "claude-sonnet-5":
      // Ultracode is a Claude Code mode; preserve it for --effort instead of
      // translating it to an API reasoning level.
      return CLAUDE_CODE_EFFORTS;
    case "claude-sonnet-4-6":
      return ["low", "medium", "high", "max"];
    default:
      return [];
  }
}

export function isModelReasoningEffortSupported(
  model: string | null | undefined,
  effort: ReasoningEffort,
): boolean {
  return getModelReasoningEfforts(model).includes(effort);
}

/** Retain a saved choice across compatible model changes; null uses defaults. */
export function compatibleReasoningEffort(
  model: string | null | undefined,
  effort: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
  return effort && isModelReasoningEffortSupported(model, effort)
    ? effort
    : null;
}
