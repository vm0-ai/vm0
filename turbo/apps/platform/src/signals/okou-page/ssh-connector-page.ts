import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { SshConnectorPage } from "../../views/okou-page/ssh-connector-page.tsx";
import { refreshSsh$ } from "../ssh.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupSshConnectorPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(refreshSsh$);
    set(updatePage$, createElement(SshConnectorPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.ssh.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
