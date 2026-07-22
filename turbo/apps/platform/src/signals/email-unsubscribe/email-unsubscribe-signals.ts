import { command, computed, state } from "ccstate";
import { emailMorningBriefUnsubscribeContract } from "@vm0/api-contracts/contracts/email-morning-brief-unsubscribe";
import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";
import { zeroClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";

export type EmailUnsubscribeScope = "all" | "morning-brief";

export type EmailUnsubscribeStatus = "idle" | "submitting" | "done" | "error";

export const emailUnsubscribeScope$ = computed((get): EmailUnsubscribeScope => {
  return get(searchParams$).get("scope") === "morning-brief"
    ? "morning-brief"
    : "all";
});

export const emailUnsubscribeToken$ = computed((get) => {
  return get(searchParams$).get("token") ?? "";
});

const internalStatus$ = state<EmailUnsubscribeStatus>("idle");

export const emailUnsubscribeStatus$ = computed((get) => {
  return get(internalStatus$);
});

export const resetEmailUnsubscribeState$ = command(({ set }) => {
  set(internalStatus$, "idle");
});

export const confirmEmailUnsubscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const token = get(emailUnsubscribeToken$);
    if (!token) {
      set(internalStatus$, "error");
      return;
    }

    set(internalStatus$, "submitting");
    const scope = get(emailUnsubscribeScope$);
    const result =
      scope === "morning-brief"
        ? await accept(
            get(zeroClient$)(emailMorningBriefUnsubscribeContract).unsubscribe({
              query: { token },
              body: undefined,
              fetchOptions: { signal },
            }),
            [200, 400],
          )
        : await accept(
            get(zeroClient$)(emailUnsubscribeContract).unsubscribe({
              query: { token },
              body: undefined,
              fetchOptions: { signal },
            }),
            [200, 400],
          );
    signal.throwIfAborted();
    set(internalStatus$, result.status === 200 ? "done" : "error");
  },
);
