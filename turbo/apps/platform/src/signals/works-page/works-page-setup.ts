import { command } from "ccstate";
import { createElement } from "react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { WorksPage } from "../../views/okou-page/works-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { initSlackOrg$, watchSlackConnection$ } from "../okou-page/slack.ts";
import { watchTeamsConnection$ } from "../okou-page/teams.ts";
import { watchGithubIntegration$ } from "../okou-page/github.ts";
import {
  setAgentPhoneConnectDialogOpen$,
  watchAgentPhoneConnection$,
} from "../okou-page/agentphone.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { detach, Reason } from "../utils.ts";
import { i18n } from "../../i18n/index.ts";

const initWorksRedirect$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  const error = params.get("error");
  const feishuError = params.get("feishuError");
  const feishuConnected = params.get("feishu") === "connected";
  if (!error && !feishuError && !feishuConnected) {
    return;
  }
  if (error || feishuError) {
    toast.error(error ?? feishuError);
  } else if (feishuConnected) {
    toast.success(
      i18n.t(($) => {
        return $.works.feishuConnected;
      }),
    );
  }
  params.delete("error");
  params.delete("feishuError");
  params.delete("feishu");
  set(replaceSearchParams$, params);
});

export const setupWorksPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(setAgentPhoneConnectDialogOpen$, false);
  set(updatePage$, createElement(WorksPage), "sidebar");
  set(
    updateDocumentTitle$,
    i18n.t(($) => {
      return $.works.documentTitle;
    }),
  );
  set(initWorksRedirect$);
  set(initSlackOrg$);

  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line ccstate/no-detach-in-signals -- route-scoped realtime subscriptions run until the /works route signal aborts
  detach(
    Promise.all([
      set(watchSlackConnection$, signal),
      set(watchTeamsConnection$, signal),
      set(watchGithubIntegration$, signal),
      set(watchAgentPhoneConnection$, signal),
    ]),
    Reason.Entrance,
    "works realtime subscriptions",
  );

  await set(hideAppSkeleton$, signal);
});
