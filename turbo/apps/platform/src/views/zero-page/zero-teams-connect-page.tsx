import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCircleCheck,
  IconLoader2,
  IconMessageCircle,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectTeamsAccount$,
  effectiveTeamsError$,
  teamsConnectStatus$,
  type TeamsConnectPageStatus,
} from "../../signals/zero-page/teams-connect-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

type PageStatus = TeamsConnectPageStatus | "checking" | "error";

function BackLink() {
  return (
    <Link
      pathname="/works"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      Back to settings
    </Link>
  );
}

export function ZeroTeamsConnectPage() {
  return (
    <div className="zero-app zero-viewport-shell flex w-full bg-background zero-workspace-bg">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="zero-card w-full max-w-sm p-5 sm:p-8 flex flex-col items-center gap-6">
          <PageContent />
        </div>
      </div>
    </div>
  );
}

function connectedLabel(params: URLSearchParams): string {
  return (
    params.get("teamName") ??
    params.get("tenantName") ??
    params.get("displayName") ??
    "Microsoft Teams"
  );
}

function PageContent() {
  const params = useGet(searchParams$);
  const tenantId = params.get("tenantId");
  const teamsUserId = params.get("teamsUserId");
  const displayName = params.get("displayName");

  const effectiveError = useGet(effectiveTeamsError$);
  const statusLoadable = useLoadable(teamsConnectStatus$);
  const status: PageStatus =
    effectiveError !== ""
      ? "error"
      : statusLoadable.state === "loading"
        ? "checking"
        : statusLoadable.state === "hasData"
          ? statusLoadable.data
          : "idle";

  const [connectLoadable, connect] = useLoadableSet(connectTeamsAccount$);
  const connectLoading = connectLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const handleConnect = () => {
    detach(connect(pageSignal), Reason.DomCallback);
  };

  if (status === "error") {
    return (
      <>
        <IconAlertCircle size={40} className="text-destructive" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            Connection Failed
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {effectiveError}
          </p>
        </div>
        <BackLink />
      </>
    );
  }

  if (status === "success") {
    const label = connectedLabel(params);
    return (
      <>
        <IconCircleCheck size={40} className="text-emerald-500" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            Connected to Microsoft Teams
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            You are connected to {label}. Mention <strong>@Zero</strong> in
            Teams to start chatting.
          </p>
        </div>
        <div className="flex flex-col gap-3 w-full">
          <Button
            size="default"
            className="w-full gap-2"
            onClick={() => {
              window.location.href = "https://teams.microsoft.com/";
            }}
          >
            <IconMessageCircle size={16} />
            Open Teams
          </Button>
          <div className="flex justify-center">
            <BackLink />
          </div>
        </div>
      </>
    );
  }

  if (status === "checking") {
    return (
      <>
        <IconLoader2 size={40} className="text-muted-foreground animate-spin" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            Checking account status...
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Please wait while we verify your connection.
          </p>
        </div>
      </>
    );
  }

  if (tenantId && teamsUserId) {
    return (
      <>
        <IconMessageCircle size={40} className="text-foreground" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            Connect Microsoft Teams
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {displayName ? `${displayName}, link` : "Link"} your Teams account
            so you can interact with your agent directly from Microsoft Teams.
          </p>
        </div>
        <Button
          className="w-full"
          size="default"
          onClick={handleConnect}
          disabled={connectLoading}
        >
          {connectLoading ? (
            <IconLoader2 size={16} className="animate-spin mr-2" />
          ) : null}
          {connectLoading ? "Connecting..." : "Connect"}
        </Button>
        <BackLink />
      </>
    );
  }

  return (
    <>
      <IconAlertCircle size={40} className="text-muted-foreground/40" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          Invalid Link
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          This page is meant to be opened from a Microsoft Teams connect link.
        </p>
      </div>
      <BackLink />
    </>
  );
}
