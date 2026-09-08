import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { CircleCheck } from "lucide-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectTeamsAccount$,
  effectiveTeamsError$,
  openTeamsClient,
  teamsConnectBotName$,
  teamsConnectStatus$,
  type TeamsConnectPageStatus,
} from "../../signals/okou-page/teams-connect-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorState,
  ConnectInvalidLinkState,
  ConnectSubmitButton,
  PageShell,
  SettingsBackLink,
} from "./connect-page-shell.tsx";

type PageStatus = TeamsConnectPageStatus | "checking" | "error";
const teamsIconImg = settingsIconAssetUrl("teams");

export function TeamsConnectPage() {
  return (
    <PageShell>
      <PageContent />
    </PageShell>
  );
}

function connectedLabel(params: URLSearchParams): string {
  return (
    params.get("teamName") ??
    params.get("tenantName") ??
    i18n.t(($) => {
      return $.connectors.providerConnect.teams.providerName;
    })
  );
}

function TeamsLogo({ size }: { readonly size: "sm" | "lg" }) {
  return (
    <span
      className={
        size === "lg"
          ? "inline-flex h-10 w-10 items-center justify-center overflow-hidden"
          : "inline-flex h-4 w-4 items-center justify-center overflow-hidden"
      }
    >
      <img
        data-testid="teams-connect-logo"
        src={teamsIconImg}
        alt=""
        className={size === "lg" ? "h-10 w-10" : "h-4 w-4"}
      />
    </span>
  );
}

function PageContent() {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const tenantId = params.get("tenantId");
  const teamsUserId = params.get("teamsUserId");
  const teamsAadObjectId = params.get("teamsAadObjectId");
  const displayName =
    params.get("teamsUserDisplayName") ?? params.get("displayName");

  const effectiveError = useGet(effectiveTeamsError$);
  const statusLoadable = useLoadable(teamsConnectStatus$);
  const botNameLoadable = useLoadable(teamsConnectBotName$);
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
    return <ConnectErrorState message={effectiveError} />;
  }

  if (status === "success") {
    const label = connectedLabel(params);
    const botName =
      botNameLoadable.state === "hasData" && botNameLoadable.data
        ? botNameLoadable.data
        : "Okou";
    return (
      <>
        <CircleCheck size={40} className="text-emerald-500" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.teams.successTitle;
          })}
          body={t(
            ($) => {
              return $.connectors.providerConnect.teams.successDescription;
            },
            { team: label, botName },
          )}
        />
        <div className="flex flex-col gap-3 w-full">
          <Button
            size="default"
            className="w-full gap-2"
            onClick={() => {
              openTeamsClient();
            }}
          >
            <TeamsLogo size="sm" />
            {t(($) => {
              return $.connectors.providerConnect.teams.open;
            })}
          </Button>
          <div className="flex justify-center">
            <SettingsBackLink />
          </div>
        </div>
      </>
    );
  }

  if (status === "checking") {
    return <ConnectCheckingState />;
  }

  if (tenantId && (teamsUserId || teamsAadObjectId)) {
    return (
      <>
        <TeamsLogo size="lg" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.teams.connectTitle;
          })}
          body={
            displayName
              ? t(
                  ($) => {
                    return $.connectors.providerConnect.teams
                      .connectDescriptionNamed;
                  },
                  { displayName },
                )
              : t(($) => {
                  return $.connectors.providerConnect.teams.connectDescription;
                })
          }
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

  return (
    <ConnectInvalidLinkState
      description={t(($) => {
        return $.connectors.providerConnect.teams.invalidDescription;
      })}
    />
  );
}
