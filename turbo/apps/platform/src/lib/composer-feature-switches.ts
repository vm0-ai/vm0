import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

type ComposerFeatureSwitches =
  | Partial<Record<FeatureSwitchKey, boolean>>
  | undefined;

export function composerInlinePromptItemsEnabled(
  features: ComposerFeatureSwitches,
): boolean {
  return (
    !(
      features?.[FeatureSwitchKey.ComposerInlineAttachmentReferences] ?? false
    ) &&
    (features?.[FeatureSwitchKey.ComposerInlinePromptItems] ?? false)
  );
}
