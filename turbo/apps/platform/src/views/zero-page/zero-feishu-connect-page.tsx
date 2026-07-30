import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
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
import {
  connectFeishuAccount$,
  feishuConnectParams$,
  feishuConnectStatus$,
} from "../../signals/zero-page/feishu-connect-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const feishuIconImg = settingsIconAssetUrl("lark");

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      pathname="/settings/feishu"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors no-underline hover:text-foreground"
    >
      <IconArrowLeft size={14} />
      {t(($) => {
        return $.connectors.providerConnect.feishu.back;
      })}
    </Link>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="zero-app zero-viewport-shell flex w-full bg-background zero-workspace-bg">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="zero-card flex w-full max-w-sm flex-col items-center gap-6 p-5 sm:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}

function FeishuMark() {
  return (
    <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-foreground/[0.04]">
      <img src={feishuIconImg} alt="" className="h-8 w-8" />
    </span>
  );
}

function CenterText({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="space-y-1.5 text-center">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : i18n.t(($) => {
        return $.connectors.providerConnect.feishu.errorFallback;
      });
}

function SuccessState({
  botName,
  openUrl,
}: {
  botName: string | null;
  openUrl: string;
}) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <IconCircleCheck size={40} className="text-emerald-500" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.feishu.successTitle;
        })}
        body={
          botName
            ? t(
                ($) => {
                  return $.connectors.providerConnect.feishu
                    .successDescriptionNamed;
                },
                { bot: botName },
              )
            : t(($) => {
                return $.connectors.providerConnect.feishu.successDescription;
              })
        }
      />
      <div className="flex w-full flex-col gap-3">
        <Button
          className="w-full gap-2"
          onClick={() => {
            window.location.href = openUrl;
          }}
        >
          <img src={feishuIconImg} alt="" className="h-4 w-4" />
          {t(($) => {
            return $.connectors.providerConnect.feishu.open;
          })}
        </Button>
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}

export function ZeroFeishuConnectPage() {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const params = useGet(feishuConnectParams$);
  const statusLoadable = useLoadable(feishuConnectStatus$);
  const [connectLoadable, connect] = useLoadableSet(connectFeishuAccount$);
  const pageSignal = useGet(pageSignal$);

  if (!params) {
    return (
      <PageShell>
        <IconAlertCircle size={40} className="text-destructive" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.common.invalidLink;
          })}
          body={t(($) => {
            return $.connectors.providerConnect.feishu.invalidDescription;
          })}
        />
        <BackLink />
      </PageShell>
    );
  }

  const result =
    connectLoadable.state === "hasData" && connectLoadable.data !== null
      ? connectLoadable.data
      : statusLoadable.state === "hasData"
        ? statusLoadable.data
        : null;
  if (result) {
    return <SuccessState botName={result.botName} openUrl={result.openUrl} />;
  }

  const connecting = connectLoadable.state === "loading";
  const checking = statusLoadable.state === "loading";
  const error =
    connectLoadable.state === "hasError"
      ? errorMessage(connectLoadable.error)
      : null;

  return (
    <PageShell>
      {connecting || checking ? (
        <IconLoader2 size={40} className="animate-spin text-muted-foreground" />
      ) : (
        <FeishuMark />
      )}
      <CenterText
        title={
          checking
            ? t(($) => {
                return $.connectors.providerConnect.feishu.checkingTitle;
              })
            : t(($) => {
                return $.connectors.providerConnect.feishu.connectTitle;
              })
        }
        body={
          checking
            ? t(($) => {
                return $.connectors.providerConnect.common.verifying;
              })
            : t(
                ($) => {
                  return $.connectors.providerConnect.feishu.connectDescription;
                },
                { brandName },
              )
        }
      />
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
          disabled={connecting || checking}
          onClick={() => {
            detach(connect(pageSignal), Reason.DomCallback);
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
