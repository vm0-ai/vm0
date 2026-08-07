import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconBrandSlack,
  IconLoader2,
  IconAlertCircle,
  IconCircleCheck,
  IconArrowLeft,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { useTranslation } from "react-i18next";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { searchParams$ } from "../../signals/route.ts";
import {
  effectiveError$,
  slackConnectStatus$,
  type SlackConnectStatus,
  connectSlackAccount$,
} from "../../signals/zero-page/slack-connect-signals.ts";

type PageStatus = SlackConnectStatus | "checking" | "error";

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      pathname="/works"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      {t(($) => {
        return $.connectors.providerConnect.common.backToSettings;
      })}
    </Link>
  );
}

export function ZeroSlackConnectPage() {
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

function ErrorState({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <>
      <IconAlertCircle size={40} className="text-destructive" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          {t(($) => {
            return $.connectors.providerConnect.common.connectionFailed;
          })}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {message}
        </p>
      </div>
      <BackLink />
    </>
  );
}

function CheckingState() {
  const { t } = useTranslation();
  return (
    <>
      <IconLoader2 size={40} className="text-muted-foreground animate-spin" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          {t(($) => {
            return $.connectors.providerConnect.common.checkingTitle;
          })}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t(($) => {
            return $.connectors.providerConnect.common.verifying;
          })}
        </p>
      </div>
    </>
  );
}

function InvalidState() {
  const { t } = useTranslation();
  return (
    <>
      <IconAlertCircle size={40} className="text-muted-foreground/40" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          {t(($) => {
            return $.connectors.providerConnect.common.invalidLink;
          })}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t(($) => {
            return $.connectors.providerConnect.slack.invalidDescription;
          })}
        </p>
      </div>
      <BackLink />
    </>
  );
}

function PageContent() {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const workspaceId = params.get("w");
  const slackUserId = params.get("u");
  const workspaceName = params.get("workspace");

  const effectiveError = useGet(effectiveError$);
  const statusLoadable = useLoadable(slackConnectStatus$);
  const status: PageStatus =
    effectiveError !== ""
      ? "error"
      : statusLoadable.state === "loading"
        ? "checking"
        : statusLoadable.state === "hasData"
          ? statusLoadable.data
          : "idle";

  const [connectLoadable, connect] = useLoadableSet(connectSlackAccount$);
  const connectLoading = connectLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const handleConnect = () => {
    detach(connect(pageSignal), Reason.DomCallback);
  };

  // Error state
  if (status === "error") {
    return <ErrorState message={effectiveError} />;
  }

  // Success state
  if (status === "success") {
    return (
      <>
        <IconCircleCheck size={40} className="text-emerald-500" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            {t(($) => {
              return $.connectors.providerConnect.slack.successTitle;
            })}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {workspaceName
              ? t(
                  ($) => {
                    return $.connectors.providerConnect.slack
                      .successDescriptionWorkspace;
                  },
                  { workspace: workspaceName },
                )
              : t(($) => {
                  return $.connectors.providerConnect.slack.successDescription;
                })}
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
            {t(($) => {
              return $.connectors.providerConnect.slack.open;
            })}
          </Button>
          <div className="flex justify-center">
            <BackLink />
          </div>
        </div>
      </>
    );
  }

  // Loading — checking login / connection status
  if (status === "checking") {
    return <CheckingState />;
  }

  // Connect confirmation (from Slack link with w + u params)
  if (workspaceId && slackUserId) {
    return (
      <>
        <IconBrandSlack size={40} className="text-foreground" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            {t(($) => {
              return $.connectors.providerConnect.slack.connectTitle;
            })}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t(($) => {
              return $.connectors.providerConnect.slack.connectDescription;
            })}
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
          {connectLoading
            ? t(($) => {
                return $.connectors.actions.connecting;
              })
            : t(($) => {
                return $.connectors.actions.connect;
              })}
        </Button>
        <BackLink />
      </>
    );
  }

  // No params — invalid access
  return <InvalidState />;
}
