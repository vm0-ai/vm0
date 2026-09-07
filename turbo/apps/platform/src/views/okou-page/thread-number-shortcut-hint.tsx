import { useGet } from "ccstate-react";
import { getShortcutLabel } from "@okouai/ui";
import {
  threadNumberShortcutHintsVisible$,
  threadNumberShortcutModifier$,
} from "../../signals/okou-page/thread-number-shortcuts.ts";

export function ThreadNumberShortcutHint({
  shortcutNumber,
}: {
  readonly shortcutNumber: number | undefined;
}) {
  const visible = useGet(threadNumberShortcutHintsVisible$);
  const modifier = useGet(threadNumberShortcutModifier$);
  if (!visible || shortcutNumber === undefined) {
    return null;
  }

  return (
    <kbd
      aria-hidden="true"
      className='pointer-events-none inline-flex h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md bg-background px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border)),0_0_0_1px_hsl(var(--border))] font-["-apple-system",BlinkMacSystemFont,"Segoe_UI",system-ui,sans-serif]'
    >
      {getShortcutLabel(`${modifier}+${shortcutNumber}`)}
    </kbd>
  );
}
