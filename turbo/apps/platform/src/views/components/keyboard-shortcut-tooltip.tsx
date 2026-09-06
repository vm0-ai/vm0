import type { ComponentProps } from "react";
import { useGet } from "ccstate-react";
import { ShortcutTooltip } from "@okouai/ui";
import { keyboardShortcutHintsVisible$ } from "../../signals/keyboard-shortcut-hints.ts";

export function KeyboardShortcutTooltip(
  props: Omit<ComponentProps<typeof ShortcutTooltip>, "hintVisible">,
) {
  const hintVisible = useGet(keyboardShortcutHintsVisible$);
  return <ShortcutTooltip {...props} hintVisible={hintVisible} />;
}
