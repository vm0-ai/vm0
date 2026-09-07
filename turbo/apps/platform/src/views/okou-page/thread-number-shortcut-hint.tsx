import { useGet } from "ccstate-react";
import { cn, getShortcutLabel } from "@okouai/ui";
import {
  threadNumberShortcutsEnabled$,
  threadNumberShortcutModifier$,
} from "../../signals/okou-page/thread-number-shortcuts.ts";

export function ThreadNumberShortcutHint({
  shortcutNumber,
  className,
}: {
  readonly shortcutNumber: number | undefined;
  readonly className?: string;
}) {
  const enabled = useGet(threadNumberShortcutsEnabled$);
  const modifier = useGet(threadNumberShortcutModifier$);
  if (!enabled || shortcutNumber === undefined) {
    return null;
  }

  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'pointer-events-none hidden h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md bg-background px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border)),0_0_0_1px_hsl(var(--border))] group-hover/shortcut:inline-flex font-["-apple-system",BlinkMacSystemFont,"Segoe_UI",system-ui,sans-serif]',
        className,
      )}
    >
      {getShortcutLabel(`${modifier}+${shortcutNumber}`)}
    </kbd>
  );
}
