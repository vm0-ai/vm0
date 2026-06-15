import { command } from "ccstate";
import { createElement } from "react";
import { ReportErrorPage } from "../../views/report-error/report-error-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { resetReportState$ } from "./report-error-signals.ts";

export const setupReportErrorPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ReportErrorPage), "minimal");
    set(updateDocumentTitle$, "Report Error");
    set(resetReportState$);

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
