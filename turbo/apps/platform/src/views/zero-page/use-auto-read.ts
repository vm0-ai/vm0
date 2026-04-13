// useEffect needed for auto-read side effects (mark loading, check completion).
// oxlint-disable-next-line no-restricted-imports
import { useEffect } from "react";
import { useGet, useSet } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  markMessageLoading$,
  checkAutoRead$,
} from "../../signals/voice-io/voice-io-tts.ts";
import { detach, Reason } from "../../signals/utils.ts";

/**
 * Track message loading→completed transitions and trigger auto-read TTS.
 */
export function useAutoRead(
  messageId: string,
  content: string,
  isLoading: boolean,
) {
  const pageSignal = useGet(pageSignal$);
  const markLoading = useSet(markMessageLoading$);
  const checkAutoReadFn = useSet(checkAutoRead$);

  useEffect(() => {
    if (isLoading) {
      markLoading(messageId);
    }
  }, [markLoading, messageId, isLoading]);

  useEffect(() => {
    if (content && !isLoading) {
      detach(
        checkAutoReadFn(messageId, content, pageSignal),
        Reason.DomCallback,
      );
    }
  }, [checkAutoReadFn, messageId, content, isLoading, pageSignal]);
}
