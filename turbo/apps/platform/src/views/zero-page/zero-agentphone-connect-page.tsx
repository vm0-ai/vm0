import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { JSX, ReactNode } from "react";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCircleCheck,
  IconLoader2,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { connectAgentPhoneAccount$ } from "../../signals/zero-page/agentphone-connect-signals.ts";
import {
  isUnreliableAgentPhoneConnectChannel,
  parseAgentPhoneConnectParams,
} from "../../signals/zero-page/agentphone-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const imessageIconImg = settingsIconAssetUrl("imessage");

function BackLink() {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

  return (
    <Link
      pathname="/works"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      {t(
        ($) => {
          return $.connectors.providerConnect.agentphone.back;
        },
        { brandName },
      )}
    </Link>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="zero-app zero-viewport-shell flex w-full bg-background zero-workspace-bg">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="zero-card w-full max-w-sm p-5 sm:p-8 flex flex-col items-center gap-6">
          {children}
        </div>
      </div>
    </div>
  );
}

function MessageMark({
  state = "idle",
}: {
  state?: "idle" | "success" | "error" | "loading";
}) {
  if (state === "success") {
    return <IconCircleCheck size={40} className="text-emerald-500" />;
  }

  if (state === "error") {
    return <IconAlertCircle size={40} className="text-destructive" />;
  }

  if (state === "loading") {
    return (
      <IconLoader2 size={40} className="animate-spin text-muted-foreground" />
    );
  }

  return (
    <span className="shrink-0 inline-flex h-10 w-10 items-center justify-center overflow-hidden">
      <img
        src={imessageIconImg}
        alt=""
        className="h-10 w-10"
        data-testid="agentphone-connect-icon"
      />
    </span>
  );
}

function CenterText({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="text-center space-y-1.5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}

function InvalidState({ title, message }: { title: string; message: string }) {
  return (
    <PageShell>
      <MessageMark state="error" />
      <CenterText title={title} body={message} />
      <BackLink />
    </PageShell>
  );
}

function SmsMmsRiskNotice({ channel }: { channel: string | null }) {
  const { t } = useTranslation();
  if (!isUnreliableAgentPhoneConnectChannel(channel)) {
    return null;
  }

  return (
    <div className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
      {t(($) => {
        return $.connectors.providerConnect.agentphone.risk;
      })}
    </div>
  );
}

function getAgentPhoneConnectErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.errorFallback;
      });
}

export function ZeroAgentPhoneConnectPage(): JSX.Element {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const params = useGet(searchParams$);
  const parsed = parseAgentPhoneConnectParams(params);
  const [connectLoadable, connectAgentPhone] = useLoadableSet(
    connectAgentPhoneAccount$,
  );
  const pageSignal = useGet(pageSignal$);
  const connecting = connectLoadable.state === "loading";
  const success =
    connectLoadable.state === "hasData" ? connectLoadable.data : null;
  const error =
    connectLoadable.state === "hasError"
      ? getAgentPhoneConnectErrorMessage(connectLoadable.error)
      : null;

  if (!parsed.ok) {
    const invalidTitle =
      parsed.error.code === "incomplete"
        ? t(($) => {
            return $.connectors.providerConnect.agentphone.incompleteTitle;
          })
        : t(($) => {
            return $.connectors.providerConnect.agentphone.invalidTitle;
          });
    const invalidMessage =
      parsed.error.code === "incomplete"
        ? t(($) => {
            return $.connectors.providerConnect.agentphone
              .incompleteDescription;
          })
        : parsed.error.code === "invalid_timestamp"
          ? t(($) => {
              return $.connectors.providerConnect.agentphone.invalidTimestamp;
            })
          : t(($) => {
              return $.connectors.providerConnect.agentphone.invalidSignature;
            });
    return <InvalidState title={invalidTitle} message={invalidMessage} />;
  }

  if (success) {
    return (
      <PageShell>
        <MessageMark state="success" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.agentphone.successTitle;
          })}
          body={t(
            ($) => {
              return $.connectors.providerConnect.agentphone.successDescription;
            },
            { phone: success.phoneHandle },
          )}
        />
        <SmsMmsRiskNotice channel={parsed.channel} />
        <BackLink />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <MessageMark state={connecting ? "loading" : "idle"} />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.connectTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.agentphone.connectDescription;
          },
          { brandName },
        )}
      />
      <SmsMmsRiskNotice channel={parsed.channel} />
      {error ? (
        <div
          className="w-full rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <div className="flex w-full flex-col gap-4">
        <Button
          className="w-full"
          disabled={connecting}
          onClick={() => {
            detach(connectAgentPhone(pageSignal), Reason.DomCallback);
          }}
        >
          {connecting ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : null}
          {connecting
            ? t(($) => {
                return $.connectors.actions.connecting;
              })
            : t(($) => {
                return $.connectors.actions.connect;
              })}
        </Button>
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}
