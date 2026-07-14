import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

type GenerationTemplateFeatureSwitches =
  | Partial<Record<FeatureSwitchKey, boolean>>
  | undefined;

export function generationTemplateForFeatureSwitches(
  value: GenerationTemplateRequest | undefined,
  features: GenerationTemplateFeatureSwitches,
): GenerationTemplateRequest | undefined {
  if (
    value?.type === "website" &&
    !(features?.[FeatureSwitchKey.WebsiteTemplates] ?? false)
  ) {
    return undefined;
  }
  if (
    value?.type === "presentation" &&
    value.selection.kind === "custom" &&
    !(features?.[FeatureSwitchKey.PresentationCustomTemplates] ?? false)
  ) {
    return undefined;
  }
  return value;
}
