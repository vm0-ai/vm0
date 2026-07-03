import { command } from "ccstate";
import { createElement } from "react";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { ZeroGithubConnectPage } from "../../views/zero-page/zero-github-connect-page.tsx";
import { parseGithubConnectParams } from "./github-connect-params.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupGithubConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    const parsed = parseGithubConnectParams(get(searchParams$));
    capturePlausibleEvent("github_connect_visit", {
      props: {
        method: parsed.ok ? "connect_signature" : "invalid",
      },
    });

    set(updatePage$, createElement(ZeroGithubConnectPage));
    set(updateDocumentTitle$, "Connect GitHub");
    await set(hideAppSkeleton$, signal);
  },
);
