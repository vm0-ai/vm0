import { command } from "ccstate";
import { createElement } from "react";
import { ExportPage } from "../../views/export-page/export-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { detach, Reason } from "../utils.ts";
import { watchUserExportStatus$ } from "./export-page-signals.ts";

export const setupExportPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(updatePage$, createElement(ExportPage));
    set(updateDocumentTitle$, "Export data");
    // eslint-disable-next-line ccstate/no-detach-in-signals -- page-scoped polling must not block route setup.
    detach(set(watchUserExportStatus$, signal), Reason.Daemon);
    await set(hideAppSkeleton$, signal);
  },
);
