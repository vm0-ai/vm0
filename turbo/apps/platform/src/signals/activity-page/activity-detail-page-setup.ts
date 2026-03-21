import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityDetailPageWrapper } from "../../views/activity-page/zero-activity-detail-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { pathParams$ } from "../route.ts";
import { setZeroActivitySelectedLogId$ } from "./activity-signals.ts";

export const setupActivityDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityDetailPageWrapper));
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
    ]);
    signal.throwIfAborted();

    const params = get(pathParams$);
    const logId =
      params && typeof params === "object" && "logId" in params
        ? String(params.logId)
        : null;

    if (logId) {
      set(setZeroActivitySelectedLogId$, logId);
    }
    set(switchActiveAgent$, null);
  },
);
