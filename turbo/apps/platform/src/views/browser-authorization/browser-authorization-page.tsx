import { IconCheck, IconLoader2, IconWorld } from "@tabler/icons-react";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui/components/ui/button";

import {
  applyBrowserAuthorizationRequest$,
  browserAuthorizationRequest$,
} from "../../signals/browser-authorization/browser-authorization.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Vm0LogoLink } from "../zero-page/zero-directed-shared.tsx";

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function ErrorState() {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center px-4">
      <div className="flex w-[430px] max-w-full flex-col items-center gap-6 rounded-xl border border-border bg-background px-6 py-10 text-center">
        <Vm0LogoLink />
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-medium text-foreground">
            Authorization link unavailable
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            This cloud browser authorization link is invalid, expired, or not
            available for this workspace.
          </p>
        </div>
      </div>
    </div>
  );
}

export function BrowserAuthorizationPage() {
  const pageSignal = useGet(pageSignal$);
  const requestLoadable = useLoadable(browserAuthorizationRequest$);
  const [applyLoadable, applyAuthorization] = useLoadableSet(
    applyBrowserAuthorizationRequest$,
  );
  const request =
    requestLoadable.state === "hasData" ? requestLoadable.data : null;

  if (requestLoadable.state === "loading") {
    return (
      <div className="fixed inset-0 z-10 flex items-center justify-center">
        <IconLoader2 size={22} className="animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (requestLoadable.state === "hasError" || !request) {
    return <ErrorState />;
  }

  const applying = applyLoadable.state === "loading";
  const enabled =
    applyLoadable.state === "hasData" ||
    request.cloudBrowserEnabled ||
    request.completedAt !== null;

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center overflow-y-auto px-4 py-8">
      <div className="flex w-[500px] max-w-full flex-col gap-6 rounded-xl border border-border bg-background px-6 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <Vm0LogoLink />
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
            <IconWorld size={22} />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-medium text-foreground">
              Enable cloud browser
            </h1>
            <p className="mx-auto max-w-md text-sm leading-5 text-muted-foreground">
              Zero will use an isolated cloud browser profile for this chat
              thread. Enabling it disconnects Computer Use for the thread.
            </p>
          </div>
        </div>

        <Button
          type="button"
          disabled={applying || enabled}
          onClick={() => {
            detach(applyAuthorization(pageSignal), Reason.DomCallback);
          }}
          className="h-10 w-full"
        >
          {applying ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : enabled ? (
            <IconCheck size={16} />
          ) : (
            <IconWorld size={16} />
          )}
          {enabled ? "Cloud browser enabled" : "Enable for this thread"}
        </Button>

        <div className="border-t border-border pt-5 text-xs text-muted-foreground">
          Link expires {formatTime(request.expiresAt)}.
        </div>
      </div>
    </div>
  );
}
