import { toast } from "@okouai/ui/components/ui/sonner";

import { i18n } from "../i18n/index.ts";
import { ACCEPT_ERROR_EVENT, type AcceptErrorEventDetail } from "./accept.ts";

globalThis.addEventListener(ACCEPT_ERROR_EVENT, (event) => {
  if (!(event instanceof CustomEvent)) {
    return;
  }
  const detail = event.detail as AcceptErrorEventDetail;
  if (detail.kind === "http-status") {
    detail.message = i18n.t(
      ($) => {
        return $.global.errors.httpStatus;
      },
      { status: detail.status ?? 0 },
    );
  } else if (detail.kind === "request-failed") {
    detail.message = i18n.t(($) => {
      return $.global.errors.requestFailed;
    });
  }
  if (detail.show && detail.message) {
    toast.error(detail.message);
  }
});
