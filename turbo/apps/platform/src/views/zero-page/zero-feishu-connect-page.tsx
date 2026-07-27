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
  return (
    <Link
      pathname="/settings/feishu"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors no-underline hover:text-foreground"
    >
      <IconArrowLeft size={14} />
      Back to Feishu settings
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
    : "We couldn't connect Feishu. Open a fresh connect link and try again.";
}

export function ZeroFeishuConnectPage() {
  const params = useGet(feishuConnectParams$);
  const statusLoadable = useLoadable(feishuConnectStatus$);
  const [connectLoadable, connect] = useLoadableSet(connectFeishuAccount$);
  const pageSignal = useGet(pageSignal$);

  if (!params) {
    return (
      <PageShell>
        <IconAlertCircle size={40} className="text-destructive" />
        <CenterText
          title="Invalid Link"
          body="Open a fresh connect link from Feishu and try again."
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
    return (
      <PageShell>
        <IconCircleCheck size={40} className="text-emerald-500" />
        <CenterText
          title="Connected to Feishu!"
          body={
            result.botName
              ? `You're connected to ${result.botName}. Send a message in Feishu to start chatting.`
              : "You're connected. Send a message in Feishu to start chatting."
          }
        />
        <div className="flex w-full flex-col gap-3">
          <Button
            className="w-full gap-2"
            onClick={() => {
              window.location.href = result.openUrl;
            }}
          >
            <img src={feishuIconImg} alt="" className="h-4 w-4" />
            Open Feishu
          </Button>
          <div className="flex justify-center">
            <BackLink />
          </div>
        </div>
      </PageShell>
    );
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
        title={checking ? "Checking account status…" : "Connect to Feishu"}
        body={
          checking
            ? "Please wait while we verify your connection."
            : "Link your VM0 account to this Feishu bot so you can work with your agent directly from Feishu."
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
          {connecting ? "Connecting..." : "Connect"}
        </Button>
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}
