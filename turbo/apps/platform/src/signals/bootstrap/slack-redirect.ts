import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";

export const handleSlackRedirect$ = command(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("updated") === "1") {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackPermissionsUpdated;
      }),
    );
    window.history.replaceState({}, "", window.location.pathname);
  } else if (params.get("installed") === "1") {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackInstalled;
      }),
    );
    window.history.replaceState({}, "", window.location.pathname);
  }
  if (params.get("connected") === "1") {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackConnected;
      }),
    );
    window.history.replaceState({}, "", window.location.pathname);
  }
});
