import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { composerInlinePromptItemsEnabled } from "../../lib/composer-feature-switches.ts";

type GenerationTemplateFeatureSwitches =
  | Partial<Record<FeatureSwitchKey, boolean>>
  | undefined;

export function generationTemplateForFeatureSwitches(
  value: GenerationTemplateRequest | undefined,
  features: GenerationTemplateFeatureSwitches,
): GenerationTemplateRequest | undefined {
  if (composerInlinePromptItemsEnabled(features)) {
    return undefined;
  }
  if (
    value?.type === "website" &&
    !(features?.[FeatureSwitchKey.WebsiteTemplates] ?? false)
  ) {
    return undefined;
  }
  return value;
}
