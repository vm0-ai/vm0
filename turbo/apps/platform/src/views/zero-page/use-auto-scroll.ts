// useLayoutEffect runs synchronously before paint, ensuring the scroll
// position is applied before the user sees the content.
// oxlint-disable-next-line no-restricted-imports
import { useLayoutEffect, useRef } from "react";
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

/**
 * Trigger auto-scroll once when `trigger` first becomes truthy.
 * Resets when `autoScroll$` changes (e.g. a new thread is opened).
 */
export function useAutoScrollOnce(
  trigger: unknown,
  autoScroll$: Command<void, []>,
) {
  const scroll = useSet(autoScroll$);
  const firedRef = useRef(false);
  const prevScrollRef = useRef(scroll);

  // Reset fired flag inside a layout effect when the scroll command changes
  // (i.e. a new thread is opened), so ref mutations never occur during render.
  useLayoutEffect(() => {
    if (prevScrollRef.current !== scroll) {
      prevScrollRef.current = scroll;
      firedRef.current = false;
    }
  }, [scroll]);

  useLayoutEffect(() => {
    if (!firedRef.current && trigger) {
      firedRef.current = true;
      scroll();
    }
  }, [scroll, trigger]);
}
