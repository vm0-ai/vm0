// useLayoutEffect needed for synchronous scroll-to-bottom before paint
// when chat messages load. Confirmed by Ethan.
// oxlint-disable-next-line no-restricted-imports
import { useLayoutEffect } from "react";
import { useSet } from "ccstate-react";
import type { Command } from "ccstate";

/**
 * Trigger auto-scroll synchronously (before paint) whenever `trigger` changes.
 */
export function useAutoScroll(
  trigger: unknown,
  autoScroll$: Command<void, []>,
) {
  const scroll = useSet(autoScroll$);
  useLayoutEffect(() => {
    scroll();
  }, [scroll, trigger]);
}
