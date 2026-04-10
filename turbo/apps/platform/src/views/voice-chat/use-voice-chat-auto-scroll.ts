// useLayoutEffect needed for synchronous scroll-to-bottom before paint
// when new voice chat events arrive.
// oxlint-disable-next-line no-restricted-imports
import { useLayoutEffect } from "react";
import { useSet } from "ccstate-react";
import {
  autoScrollTranscript$,
  autoScrollEvents$,
} from "../../signals/voice-chat/voice-chat-auto-scroll.ts";

export function useTranscriptAutoScroll(trigger: unknown) {
  const scroll = useSet(autoScrollTranscript$);
  useLayoutEffect(() => {
    scroll();
  }, [scroll, trigger]);
}

export function useEventsAutoScroll(trigger: unknown) {
  const scroll = useSet(autoScrollEvents$);
  useLayoutEffect(() => {
    scroll();
  }, [scroll, trigger]);
}
