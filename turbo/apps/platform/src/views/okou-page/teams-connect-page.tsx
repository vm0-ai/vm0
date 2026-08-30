import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, ArrowLeft, CircleCheck, Loader2 } from "lucide-react";
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
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

type PageStatus = TeamsConnectPageStatus | "checking" | "error";
const teamsIconImg = settingsIconAssetUrl("teams");

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      pathname="/works"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <ArrowLeft size={14} />
      {t(($) => {
        return $.connectors.providerConnect.common.backToSettings;
      })}
    </Link>
  );
}

export function TeamsConnectPage() {
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
    i18n.t(($) => {
      return $.connectors.providerConnect.teams.providerName;
    })
  );
}

function teamsParam(
  params: URLSearchParams,
  primary: string,
  fallback?: string,
): string | null {
  return params.get(primary) ?? (fallback ? params.get(fallback) : null);
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

function ErrorState({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <>
      <AlertCircle size={40} className="text-destructive" />
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
      <Loader2 size={40} className="animate-spin" />
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
      <AlertCircle size={40} className="" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          {t(($) => {
            return $.connectors.providerConnect.common.invalidLink;
          })}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t(($) => {
            return $.connectors.providerConnect.teams.invalidDescription;
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
  const tenantId = params.get("tenantId");
  const teamsUserId = params.get("teamsUserId");
  const teamsAadObjectId = params.get("teamsAadObjectId");
  const displayName = teamsParam(params, "teamsUserDisplayName", "displayName");

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
    return <ErrorState message={effectiveError} />;
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
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            {t(($) => {
              return $.connectors.providerConnect.teams.successTitle;
            })}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t(
              ($) => {
                return $.connectors.providerConnect.teams.successDescription;
              },
              { team: label, botName },
            )}
          </p>
        </div>
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
            <BackLink />
          </div>
        </div>
      </>
    );
  }

  if (status === "checking") {
    return <CheckingState />;
  }

  if (tenantId && (teamsUserId || teamsAadObjectId)) {
    return (
      <>
        <TeamsLogo size="lg" />
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            {t(($) => {
              return $.connectors.providerConnect.teams.connectTitle;
            })}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {displayName
              ? t(
                  ($) => {
                    return $.connectors.providerConnect.teams
                      .connectDescriptionNamed;
                  },
                  { displayName },
                )
              : t(($) => {
                  return $.connectors.providerConnect.teams.connectDescription;
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
            <Loader2 size={16} className="animate-spin mr-2" />
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

  return <InvalidState />;
}
