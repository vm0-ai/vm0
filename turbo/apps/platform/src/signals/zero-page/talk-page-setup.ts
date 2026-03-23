import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTalkPageWrapper } from "../../views/zero-page/zero-talk-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { logger } from "../log.ts";
import { loadInitialData$, resolveAgentByName } from "./zero-page.ts";

const L = logger("TalkPage");

export const setupTalkPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroTalkPageWrapper));

    await set(loadInitialData$, signal);

    // Resolve agent from /talk/:name
    const params = get(pathParams$) as { name?: string } | undefined;
    const agentName = params?.name ?? null;
    L.info("resolveAgent talk:", agentName);

    await resolveAgentByName(get, set, signal, agentName);

    set(syncModelPreference$);
  },
);
