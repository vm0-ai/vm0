import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { SshSettingsPage } from "../../views/okou-page/ssh-settings-page.tsx";
import { refreshSsh$ } from "../ssh.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupSshSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(refreshSsh$);
    set(updatePage$, createElement(SshSettingsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.ssh.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
