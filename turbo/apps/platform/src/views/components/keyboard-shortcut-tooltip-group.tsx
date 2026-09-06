import type { ComponentProps } from "react";
import { useGet } from "ccstate-react";
import { ShortcutTooltipGroup } from "@okouai/ui";
import { keyboardShortcutHintsVisible$ } from "../../signals/keyboard-shortcut-hints.ts";

export function KeyboardShortcutTooltipGroup(
  props: Omit<ComponentProps<typeof ShortcutTooltipGroup>, "hintVisible">,
) {
  const hintVisible = useGet(keyboardShortcutHintsVisible$);
  return <ShortcutTooltipGroup {...props} hintVisible={hintVisible} />;
}
