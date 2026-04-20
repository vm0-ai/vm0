import { useGet, useSet } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconBrandSlack,
  IconLoader2,
  IconAlertCircle,
  IconCircleCheck,
  IconArrowLeft,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { searchParams$ } from "../../signals/route.ts";
import {
  slackConnectStatus$,
  effectiveStatus$,
  effectiveError$,
  connectSlackAccount$,
} from "../../signals/zero-page/slack-connect-signals.ts";

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

/**
 * Slack Connect page — handles connect confirmation, success, and error states.
 *
 * URL params:
 * - w, u: workspace and slack user IDs (for manual connect flow from Slack)
 * - status=connected: post-install or post-connect success
 * - workspace: workspace name (for display after connect)
 * - error: error message to display
 */
export function ZeroSlackConnectPage() {
  const params = useGet(searchParams$);
  const workspaceId = params.get("w");
  const slackUserId = params.get("u");
  const workspaceName = params.get("workspace");

  const status = useGet(slackConnectStatus$);
  const eStatus = useGet(effectiveStatus$);
  const eError = useGet(effectiveError$);

  const connect = useSet(connectSlackAccount$);
  const pageSignal = useGet(pageSignal$);
  const handleConnect = () => {
    detach(connect(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="zero-app flex h-dvh w-full bg-background zero-workspace-bg">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="zero-card w-full max-w-sm p-5 sm:p-8 flex flex-col items-center gap-6">
          <PageContent
            effectiveStatus={eStatus}
            effectiveError={eError}
            workspaceName={workspaceName}
            workspaceId={workspaceId}
            slackUserId={slackUserId}
            connectStatus={status}
            onConnect={handleConnect}
          />
        </div>
      </div>
    </div>
  );
}

function PageContent({
  effectiveStatus,
  effectiveError,
  workspaceName,
  workspaceId,
  slackUserId,
  connectStatus,
  onConnect,
}: {
  effectiveStatus: string;
  effectiveError: string;
  workspaceName: string | null;
  workspaceId: string | null;
  slackUserId: string | null;
  connectStatus: string;
  onConnect: () => void;
}) {
  // Error state
  if (effectiveStatus === "error") {
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

  // Success state
  if (effectiveStatus === "success") {
    return (
      <>
        <IconCircleCheck size={40} className="text-emerald-500" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            Connected to Slack!
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {workspaceName ? `You're connected to ${workspaceName}. ` : ""}
            Mention <strong>@Zero</strong> in any channel or send a DM to start
            chatting.
          </p>
        </div>
        <div className="flex flex-col gap-3 w-full">
          <Button
            size="default"
            className="w-full gap-2"
            onClick={() => {
              window.location.href = "slack://open";
            }}
          >
            <IconBrandSlack size={16} />
            Open Slack
          </Button>
          <div className="flex justify-center">
            <BackLink />
          </div>
        </div>
      </>
    );
  }

  // Loading — checking login / connection status
  if (effectiveStatus === "checking") {
    return (
      <>
        <IconLoader2 size={40} className="text-muted-foreground animate-spin" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            Checking account status…
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Please wait while we verify your connection.
          </p>
        </div>
      </>
    );
  }

  // Connect confirmation (from Slack link with w + u params)
  if (workspaceId && slackUserId) {
    return (
      <>
        <IconBrandSlack size={40} className="text-foreground" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            Connect to Slack
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Link your account to this Slack workspace so you can interact with
            your agent directly from Slack.
          </p>
        </div>
        <Button
          className="w-full"
          size="default"
          onClick={onConnect}
          disabled={connectStatus === "connecting"}
        >
          {connectStatus === "connecting" ? (
            <IconLoader2 size={16} className="animate-spin mr-2" />
          ) : null}
          {connectStatus === "connecting" ? "Connecting..." : "Connect"}
        </Button>
        <BackLink />
      </>
    );
  }

  // No params — invalid access
  return (
    <>
      <IconAlertCircle size={40} className="text-muted-foreground/40" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          Invalid Link
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          This page is meant to be opened from a Slack connect link.
        </p>
      </div>
      <BackLink />
    </>
  );
}
