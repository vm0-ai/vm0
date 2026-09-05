import { useGet } from "ccstate-react";
import { getShortcutParts } from "@okouai/ui";
import { threadNumberShortcutHintsVisible$ } from "../../signals/okou-page/thread-number-shortcuts.ts";

export function ThreadNumberShortcutHint({
  shortcutNumber,
}: {
  readonly shortcutNumber: number | undefined;
}) {
  const visible = useGet(threadNumberShortcutHintsVisible$);
  if (!visible || shortcutNumber === undefined) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none inline-flex shrink-0 items-center gap-1 duration-150 animate-in fade-in slide-in-from-right-2 motion-reduce:animate-none"
    >
      {getShortcutParts(`mod+${shortcutNumber}`).map((part) => {
        return (
          <kbd
            key={part}
            className='inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-background px-1 text-[10px] font-medium leading-none text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border)),0_0_0_1px_hsl(var(--border))] font-["-apple-system",BlinkMacSystemFont,"Segoe_UI",system-ui,sans-serif]'
          >
            {part}
          </kbd>
        );
      })}
    </span>
  );
}
