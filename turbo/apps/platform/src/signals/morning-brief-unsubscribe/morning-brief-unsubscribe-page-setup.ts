import { command } from "ccstate";
import { createElement } from "react";
import { emailMorningBriefUnsubscribeContract } from "@vm0/api-contracts/contracts/email-morning-brief-unsubscribe";
import { MorningBriefUnsubscribePage } from "../../views/morning-brief-unsubscribe-page/morning-brief-unsubscribe-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setMorningBriefUnsubscribeStatus$ } from "./morning-brief-unsubscribe-signals.ts";

/**
 * Setup command for the public `/email/morning-brief/unsubscribe` route.
 *
 * This route has no auth guard — it is opened straight from the Morning
 * Brief email, possibly on a device without a session. The signed token in
 * the query string is the only credential; the API validates it on the
 * one-click unsubscribe endpoint.
 */
export const setupMorningBriefUnsubscribePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(MorningBriefUnsubscribePage));
    set(updateDocumentTitle$, "Morning Brief");

    const token = get(searchParams$).get("token");
    if (!token) {
      set(setMorningBriefUnsubscribeStatus$, "invalid");
      await set(hideAppSkeleton$, signal);
      return;
    }

    const client = get(zeroClient$)(emailMorningBriefUnsubscribeContract);
    const result = await accept(
      client.unsubscribe({ query: { token }, body: undefined }),
      [200, 400],
    );
    signal.throwIfAborted();
    set(
      setMorningBriefUnsubscribeStatus$,
      result.status === 200 ? "unsubscribed" : "invalid",
    );

    await set(hideAppSkeleton$, signal);
  },
);
