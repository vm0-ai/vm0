import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { CircleCheck } from "lucide-react";
import { Button, BrandSlack } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { detach, Reason } from "../../signals/utils.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  effectiveError$,
  slackConnectStatus$,
  type SlackConnectStatus,
  connectSlackAccount$,
} from "../../signals/okou-page/slack-connect-signals.ts";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorState,
  ConnectInvalidLinkState,
  ConnectSubmitButton,
  PageShell,
  SettingsBackLink,
} from "./connect-page-shell.tsx";

type PageStatus = SlackConnectStatus | "checking" | "error";

export function SlackConnectPage() {
  return (
    <PageShell>
      <PageContent />
    </PageShell>
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
    return <ConnectErrorState message={effectiveError} />;
  }

  // Success state
  if (status === "success") {
    return (
      <>
        <CircleCheck size={40} className="text-emerald-500" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.slack.successTitle;
          })}
          body={
            workspaceName
              ? t(
                  ($) => {
                    return $.connectors.providerConnect.slack
                      .successDescriptionWorkspace;
                  },
                  { workspace: workspaceName },
                )
              : t(($) => {
                  return $.connectors.providerConnect.slack.successDescription;
                })
          }
        />
        <div className="flex flex-col gap-3 w-full">
          <Button
            size="default"
            className="w-full gap-2"
            onClick={() => {
              window.location.href = "slack://open";
            }}
          >
            <BrandSlack size={16} />
            {t(($) => {
              return $.connectors.providerConnect.slack.open;
            })}
          </Button>
          <div className="flex justify-center">
            <SettingsBackLink />
          </div>
        </div>
      </>
    );
  }

  // Loading — checking login / connection status
  if (status === "checking") {
    return <ConnectCheckingState />;
  }

  // Connect confirmation (from Slack link with w + u params)
  if (workspaceId && slackUserId) {
    return (
      <>
        <BrandSlack size={40} className="" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.slack.connectTitle;
          })}
          body={t(($) => {
            return $.connectors.providerConnect.slack.connectDescription;
          })}
        />
        <ConnectSubmitButton
          connecting={connectLoading}
          onConnect={handleConnect}
          spinnerClassName="animate-spin mr-2"
        />
        <SettingsBackLink />
      </>
    );
  }

  // No params — invalid access
  return (
    <ConnectInvalidLinkState
      description={t(($) => {
        return $.connectors.providerConnect.slack.invalidDescription;
      })}
    />
  );
}
