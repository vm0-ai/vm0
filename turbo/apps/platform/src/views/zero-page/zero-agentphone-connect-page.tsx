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
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { connectAgentPhoneAccount$ } from "../../signals/zero-page/agentphone-connect-signals.ts";
import {
  AGENTPHONE_SMS_MMS_CONNECT_RISK_MESSAGE,
  isUnreliableAgentPhoneConnectChannel,
  parseAgentPhoneConnectParams,
} from "../../signals/zero-page/agentphone-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import imessageIconImg from "./components/settings/icons/imessage.svg";

function BackLink() {
  return (
    <Link
      pathname="/works"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      Back to VM0
    </Link>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="zero-app flex h-dvh w-full bg-background zero-workspace-bg">
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
  if (!isUnreliableAgentPhoneConnectChannel(channel)) {
    return null;
  }

  return (
    <div className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
      {AGENTPHONE_SMS_MMS_CONNECT_RISK_MESSAGE}
    </div>
  );
}

function getAgentPhoneConnectErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "We couldn't connect this phone number. Try again from your text messages.";
}

export function ZeroAgentPhoneConnectPage(): JSX.Element {
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
    return (
      <InvalidState title={parsed.error.title} message={parsed.error.message} />
    );
  }

  if (success) {
    return (
      <PageShell>
        <MessageMark state="success" />
        <CenterText
          title="Phone number connected"
          body={
            <>
              <span className="font-medium">{success.phoneHandle}</span> is
              connected. Send a text message to start chatting with Zero.
            </>
          }
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
        title="Connect phone number"
        body="Link this phone number to your VM0 account so you can interact with Zero from text messages."
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
          {connecting ? "Connecting..." : "Connect"}
        </Button>
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}
