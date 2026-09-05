import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { connectAgentPhoneAccount$ } from "../../signals/okou-page/agentphone-connect-signals.ts";
import {
  isUnreliableAgentPhoneConnectChannel,
  parseAgentPhoneConnectParams,
} from "../../signals/okou-page/agentphone-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  CenterText,
  ConnectBackLink,
  ConnectErrorAlert,
  ConnectStatusMark,
  ConnectSubmitButton,
  PageShell,
  connectErrorMessage,
  type MarkState,
} from "./connect-page-shell.tsx";

const imessageIconImg = settingsIconAssetUrl("imessage");

function BackLink() {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

  return (
    <ConnectBackLink
      pathname="/works"
      label={t(
        ($) => {
          return $.connectors.providerConnect.agentphone.back;
        },
        { brandName },
      )}
    />
  );
}

function MessageMark({ state }: { state?: MarkState }) {
  return (
    <ConnectStatusMark
      state={state}
      idle={
        <span className="shrink-0 inline-flex h-10 w-10 items-center justify-center overflow-hidden">
          <img
            src={imessageIconImg}
            alt=""
            className="h-10 w-10"
            data-testid="agentphone-connect-icon"
          />
        </span>
      }
    />
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

export function AgentPhoneConnectPage(): JSX.Element {
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
      ? connectErrorMessage(
          connectLoadable.error,
          i18n.t(($) => {
            return $.connectors.providerConnect.agentphone.errorFallback;
          }),
        )
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
      <ConnectErrorAlert error={error} />
      <div className="flex w-full flex-col gap-4">
        <ConnectSubmitButton
          connecting={connecting}
          onConnect={() => {
            detach(connectAgentPhone(pageSignal), Reason.DomCallback);
          }}
        />
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}
