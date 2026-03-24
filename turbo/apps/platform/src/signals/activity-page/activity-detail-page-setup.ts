import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityDetailPageWrapper } from "../../views/activity-page/zero-activity-detail-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { setZeroActivitySelectedLogId$ } from "./activity-signals.ts";

export const setupActivityDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityDetailPageWrapper));
    set(updateDocumentTitle$, "Activity");

    // Set logId immediately so the component shows skeleton instead of stale data
    const params = get(pathParams$);
    const logId =
      params && typeof params === "object" && "logId" in params
        ? String(params.logId)
        : null;

    if (logId) {
      set(setZeroActivitySelectedLogId$, logId);
    }

    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(switchActiveAgent$, null);
  },
);
