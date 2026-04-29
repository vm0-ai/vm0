import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import type { JSX, ReactNode } from "react";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCircleCheck,
  IconLoader2,
} from "@tabler/icons-react";
import { Button, CopyButton } from "@vm0/ui";
import { clerk$, resolveWebOrigin } from "../../signals/auth.ts";
import { apiBaseForNavigation$ } from "../../signals/fetch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectTelegramAccount$,
  telegramConnectError$,
  telegramConnectLinkStatus$,
  telegramConnectStatus$,
  telegramConnectSuccess$,
} from "../../signals/zero-page/telegram-connect-signals.ts";
import {
  telegramAutoOpenRef$,
  telegramDomainStatusPollerRef$,
} from "../../signals/view-component-state.ts";
import {
  parseTelegramConnectParams,
  type TelegramConnectParams,
} from "../../signals/zero-page/telegram-connect-params.ts";
import { openTelegramLoginPopup } from "../../signals/zero-page/telegram-login-popup.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import telegramIconImg from "./components/settings/icons/telegram.svg";

function signInHref(): string {
  const webOrigin = resolveWebOrigin();
  const signInPath = `${webOrigin}/sign-in`;
  return `${signInPath}?redirect_url=${encodeURIComponent(location.href)}`;
}

function BackLink() {
  return (
    <Link
      pathname="/settings/telegram"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      Back to Telegram settings
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

function TelegramMark({
  state = "idle",
}: {
  state?: "idle" | "success" | "error" | "loading" | "warning";
}) {
  if (state === "success") {
    return <IconCircleCheck size={40} className="text-emerald-500" />;
  }

  if (state === "warning") {
    return <IconAlertCircle size={40} className="text-amber-500" />;
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
    <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-[#2AABEE]/10">
      <img src={telegramIconImg} alt="" className="h-8 w-8" />
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
      <TelegramMark state="error" />
      <CenterText title={title} body={message} />
      <BackLink />
    </PageShell>
  );
}

function TelegramAutoOpen({ href }: { href: string }) {
  const telegramAutoOpenRef = useSet(telegramAutoOpenRef$);

  return (
    <span
      key={href}
      ref={telegramAutoOpenRef}
      data-telegram-href={href}
      hidden
    />
  );
}

function SuccessState({ botUsername }: { botUsername: string }) {
  const telegramHref = `tg://resolve?domain=${botUsername.replace(/^@/, "")}`;

  return (
    <PageShell>
      <TelegramAutoOpen href={telegramHref} />
      <TelegramMark state="success" />
      <CenterText
        title="Connected to Telegram!"
        body={
          <>
            You&apos;re connected to{" "}
            <span className="font-medium">
              @{botUsername.replace(/^@/, "")}
            </span>
            . Send a message in Telegram to start chatting.
          </>
        }
      />
      <div className="flex w-full flex-col gap-3">
        <Button
          className="w-full"
          onClick={() => {
            window.location.assign(telegramHref);
          }}
        >
          <img src={telegramIconImg} alt="" className="h-4 w-4" />
          Open Telegram
        </Button>
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}

function AlreadyConnectedState({
  botUsername,
}: {
  botUsername: string | undefined;
}) {
  const normalizedBotUsername = botUsername?.replace(/^@/, "");
  const telegramHref = normalizedBotUsername
    ? `tg://resolve?domain=${normalizedBotUsername}`
    : null;

  return (
    <PageShell>
      <TelegramMark state="success" />
      <CenterText
        title="Already connected to Telegram"
        body={
          <>
            {normalizedBotUsername ? (
              <>
                You&apos;re already connected to{" "}
                <span className="font-medium">@{normalizedBotUsername}</span>.
                Send a message in Telegram to start chatting.
              </>
            ) : (
              "You're already connected. Send a message in Telegram to start chatting."
            )}
          </>
        }
      />
      <div className="flex w-full flex-col gap-3">
        {telegramHref ? (
          <Button
            className="w-full"
            onClick={() => {
              window.location.assign(telegramHref);
            }}
          >
            <img src={telegramIconImg} alt="" className="h-4 w-4" />
            Open Telegram
          </Button>
        ) : null}
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}

function getTelegramLoginDomain(): string {
  if (typeof location === "undefined" || !location.hostname) {
    return "your app domain";
  }
  return location.hostname;
}

function DomainStatusPolling() {
  const domainStatusPollerRef = useSet(telegramDomainStatusPollerRef$);

  return (
    <>
      <span ref={domainStatusPollerRef} hidden />
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <IconLoader2 size={13} className="animate-spin" />
        Checking domain status...
      </div>
    </>
  );
}

function DomainSetupState({
  botUsername,
}: {
  botUsername: string | undefined;
}) {
  const domain = getTelegramLoginDomain();
  const normalizedBotUsername = botUsername?.replace(/^@/, "");

  return (
    <PageShell>
      <TelegramMark state="warning" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          Set Telegram login domain
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Telegram web login is not enabled for{" "}
          {normalizedBotUsername ? (
            <span className="font-medium">@{normalizedBotUsername}</span>
          ) : (
            "this bot"
          )}
          .
        </p>
      </div>
      <div className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-relaxed text-foreground">
        <p>
          In{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            @BotFather
          </a>
          , send{" "}
          <code className="rounded border border-amber-500/30 bg-background/80 px-1 py-0.5 font-mono text-xs">
            /setdomain
          </code>
          , choose the bot, then set the domain to:
        </p>
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
          <code className="min-w-0 truncate font-mono text-xs">{domain}</code>
          <CopyButton
            text={domain}
            className="shrink-0 p-1.5 hover:bg-accent"
          />
        </div>
        <p className="mt-3 text-muted-foreground">
          Keep this page open after saving the domain. You can also connect from
          Telegram with <code className="font-mono text-xs">/connect</code>.
        </p>
        <DomainStatusPolling />
      </div>
      <div className="flex w-full flex-col gap-3">
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Open BotFather
        </a>
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}

function ConnectActions({
  parsed,
  apiBase,
  connecting,
  onConnectSigned,
}: {
  parsed: TelegramConnectParams;
  apiBase: string;
  connecting: boolean;
  onConnectSigned: () => void;
}) {
  const openLogin = () => {
    openTelegramLoginPopup(parsed.telegramBotId, apiBase);
  };

  if (parsed.connectSignature) {
    return (
      <div className="flex w-full flex-col gap-3">
        <Button
          className="w-full"
          disabled={connecting}
          onClick={onConnectSigned}
        >
          {connecting ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : null}
          {connecting ? "Connecting..." : "Connect"}
        </Button>
      </div>
    );
  }

  return (
    <Button className="w-full" disabled={connecting} onClick={openLogin}>
      {connecting ? <IconLoader2 size={16} className="animate-spin" /> : null}
      {connecting ? "Connecting..." : "Continue with Telegram"}
    </Button>
  );
}

export function ZeroTelegramConnectPage(): JSX.Element {
  const params = useGet(searchParams$);
  const apiBase = useGet(apiBaseForNavigation$);
  const parsed = parseTelegramConnectParams(params);
  const clerkLoadable = useLoadable(clerk$);
  const linkStatusLoadable = useLastLoadable(telegramConnectLinkStatus$);
  const status = useGet(telegramConnectStatus$);
  const error = useGet(telegramConnectError$);
  const success = useGet(telegramConnectSuccess$);
  const connectTelegram = useSet(connectTelegramAccount$);
  const pageSignal = useGet(pageSignal$);
  const connecting = status === "connecting";

  if (!parsed.ok) {
    return (
      <InvalidState title={parsed.error.title} message={parsed.error.message} />
    );
  }

  if (clerkLoadable.state === "loading") {
    return (
      <PageShell>
        <TelegramMark state="loading" />
        <CenterText
          title="Checking account status..."
          body="Please wait while we verify your VM0 session."
        />
      </PageShell>
    );
  }

  if (clerkLoadable.state === "hasError") {
    return (
      <InvalidState
        title="Couldn't check sign-in"
        message="Refresh this page and try again."
      />
    );
  }

  if (!clerkLoadable.data.user) {
    return (
      <PageShell>
        <TelegramMark />
        <CenterText
          title="Sign in to continue"
          body="Use your VM0 account before connecting this Telegram user."
        />
        <a
          href={signInHref()}
          className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Sign in to VM0
        </a>
      </PageShell>
    );
  }

  if (success) {
    return <SuccessState botUsername={success.botUsername} />;
  }

  if (linkStatusLoadable.state === "loading") {
    return (
      <PageShell>
        <TelegramMark state="loading" />
        <CenterText
          title="Checking connection..."
          body="Please wait while we check your Telegram connection."
        />
      </PageShell>
    );
  }

  const linkStatus =
    linkStatusLoadable.state === "hasData" ? linkStatusLoadable.data : null;
  if (linkStatus?.linked) {
    return <AlreadyConnectedState botUsername={linkStatus.botUsername} />;
  }
  if (
    !parsed.params.connectSignature &&
    linkStatus?.installation?.domainConfigured === false
  ) {
    return (
      <DomainSetupState botUsername={linkStatus.installation.botUsername} />
    );
  }

  return (
    <PageShell>
      <TelegramMark />
      <CenterText
        title="Connect to Telegram"
        body="Link your account to this Telegram bot so you can interact with your agent directly from Telegram."
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
        <ConnectActions
          parsed={parsed.params}
          apiBase={apiBase}
          connecting={connecting}
          onConnectSigned={() => {
            detach(
              connectTelegram(parsed.params, pageSignal),
              Reason.DomCallback,
            );
          }}
        />
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}
