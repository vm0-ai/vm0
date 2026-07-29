import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { JSX, ReactNode } from "react";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCircleCheck,
  IconLoader2,
} from "@tabler/icons-react";
import { Button, CopyButton } from "@vm0/ui";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { clerk$, resolveAppAuthUrl } from "../../signals/auth.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectTelegramAccount$,
  telegramConnectLinkStatus$,
} from "../../signals/zero-page/telegram-connect-signals.ts";
import {
  telegramAutoOpenRef$,
  telegramDomainStatusPollerRef$,
} from "../../signals/view-component-state.ts";
import {
  parseTelegramConnectParams,
  type TelegramConnectParams,
} from "../../signals/zero-page/telegram-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const telegramIconImg = settingsIconAssetUrl("telegram");

function signInHref(): string {
  return resolveAppAuthUrl("/sign-in", { redirectUrl: location.href });
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      pathname="/settings/telegram"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      {t(($) => {
        return $.connectors.providerConnect.telegram.back;
      })}
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
  const { t } = useTranslation();
  const telegramHref = `tg://resolve?domain=${botUsername.replace(/^@/, "")}`;
  const botLabel = `@${botUsername.replace(/^@/, "")}`;

  return (
    <PageShell>
      <TelegramAutoOpen href={telegramHref} />
      <TelegramMark state="success" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.successTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.telegram.successDescription;
          },
          { bot: botLabel },
        )}
      />
      <div className="flex w-full flex-col gap-3">
        <Button
          className="w-full"
          onClick={() => {
            window.location.assign(telegramHref);
          }}
        >
          <img src={telegramIconImg} alt="" className="h-4 w-4" />
          {t(($) => {
            return $.connectors.providerConnect.telegram.open;
          })}
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
  const { t } = useTranslation();
  const normalizedBotUsername = botUsername?.replace(/^@/, "");
  const telegramHref = normalizedBotUsername
    ? `tg://resolve?domain=${normalizedBotUsername}`
    : null;

  return (
    <PageShell>
      <TelegramMark state="success" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.alreadyTitle;
        })}
        body={
          normalizedBotUsername
            ? t(
                ($) => {
                  return $.connectors.providerConnect.telegram
                    .alreadyDescriptionNamed;
                },
                { bot: `@${normalizedBotUsername}` },
              )
            : t(($) => {
                return $.connectors.providerConnect.telegram.alreadyDescription;
              })
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
            {t(($) => {
              return $.connectors.providerConnect.telegram.open;
            })}
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
  return location.hostname;
}

function getTelegramConnectErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : i18n.t(($) => {
        return $.connectors.providerConnect.telegram.errorFallback;
      });
}

function DomainStatusPolling() {
  const { t } = useTranslation();
  const domainStatusPollerRef = useSet(telegramDomainStatusPollerRef$);

  return (
    <>
      <span ref={domainStatusPollerRef} hidden />
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <IconLoader2 size={13} className="animate-spin" />
        {t(($) => {
          return $.connectors.providerConnect.telegram.checkingDomain;
        })}
      </div>
    </>
  );
}

function DomainSetupState({
  botUsername,
}: {
  botUsername: string | undefined;
}) {
  const { t } = useTranslation();
  const domain = getTelegramLoginDomain();
  const normalizedBotUsername = botUsername?.replace(/^@/, "");
  const botLabel = normalizedBotUsername
    ? `@${normalizedBotUsername}`
    : t(($) => {
        return $.connectors.providerConnect.telegram.botFallback;
      });

  return (
    <PageShell>
      <TelegramMark state="warning" />
      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">
          {t(($) => {
            return $.connectors.providerConnect.telegram.domainTitle;
          })}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t(
            ($) => {
              return $.connectors.providerConnect.telegram.domainDescription;
            },
            { bot: botLabel },
          )}
        </p>
      </div>
      <div className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-relaxed text-foreground">
        <p>
          {t(($) => {
            return $.connectors.providerConnect.telegram.domainIn;
          })}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            @BotFather
          </a>
          {t(($) => {
            return $.connectors.providerConnect.telegram.domainSend;
          })}
          <code className="rounded border border-amber-500/30 bg-background/80 px-1 py-0.5 font-mono text-xs">
            /setdomain
          </code>
          {t(($) => {
            return $.connectors.providerConnect.telegram
              .domainInstructionsAfter;
          })}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
          <code className="min-w-0 truncate font-mono text-xs">{domain}</code>
          <CopyButton
            text={domain}
            className="shrink-0 p-1.5 hover:bg-accent"
          />
        </div>
        <p className="mt-3 text-muted-foreground">
          {t(($) => {
            return $.connectors.providerConnect.telegram.domainKeepOpen;
          })}
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
          {t(($) => {
            return $.connectors.providerConnect.telegram.openBotFather;
          })}
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
  connecting,
  onConnect,
}: {
  parsed: TelegramConnectParams;
  connecting: boolean;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  if (parsed.connectSignature) {
    return (
      <div className="flex w-full flex-col gap-3">
        <Button className="w-full" disabled={connecting} onClick={onConnect}>
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
      </div>
    );
  }

  return (
    <Button className="w-full" disabled={connecting} onClick={onConnect}>
      {connecting ? <IconLoader2 size={16} className="animate-spin" /> : null}
      {connecting
        ? t(($) => {
            return $.connectors.actions.connecting;
          })
        : t(($) => {
            return $.connectors.providerConnect.telegram.continue;
          })}
    </Button>
  );
}

type TelegramConnectParamErrorCode = Extract<
  ReturnType<typeof parseTelegramConnectParams>,
  { ok: false }
>["error"]["code"];

function InvalidTelegramConnectParams({
  code,
}: {
  code: TelegramConnectParamErrorCode;
}) {
  const { t } = useTranslation();
  const title =
    code === "incomplete"
      ? t(($) => {
          return $.connectors.providerConnect.telegram.linkIncompleteTitle;
        })
      : t(($) => {
          return $.connectors.providerConnect.telegram.invalidTitle;
        });
  const messages: Record<TelegramConnectParamErrorCode, string> = {
    incomplete: t(($) => {
      return $.connectors.providerConnect.telegram.linkIncomplete;
    }),
    invalid_signature: t(($) => {
      return $.connectors.providerConnect.telegram.invalidSignature;
    }),
    invalid_timestamp: t(($) => {
      return $.connectors.providerConnect.telegram.invalidTimestamp;
    }),
    invalid_user: t(($) => {
      return $.connectors.providerConnect.telegram.invalidUser;
    }),
    invalid_username: t(($) => {
      return $.connectors.providerConnect.telegram.invalidUsername;
    }),
  };
  return <InvalidState title={title} message={messages[code]} />;
}

function TelegramSessionLoadingState({ brandName }: { brandName: string }) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <TelegramMark state="loading" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.common.checkingTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.telegram.checkingSession;
          },
          { brandName },
        )}
      />
    </PageShell>
  );
}

function TelegramSignInState({ brandName }: { brandName: string }) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <TelegramMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.signInTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.telegram.signInDescription;
          },
          { brandName },
        )}
      />
      <a
        href={signInHref()}
        className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t(
          ($) => {
            return $.connectors.providerConnect.telegram.signInButton;
          },
          { brandName },
        )}
      </a>
    </PageShell>
  );
}

function TelegramConnectionLoadingState() {
  const { t } = useTranslation();
  return (
    <PageShell>
      <TelegramMark state="loading" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.checkingConnectionTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.telegram
            .checkingConnectionDescription;
        })}
      />
    </PageShell>
  );
}

export function ZeroTelegramConnectPage(): JSX.Element {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const params = useGet(searchParams$);
  const parsed = parseTelegramConnectParams(params);
  const clerkLoadable = useLoadable(clerk$);
  const linkStatusLoadable = useLastLoadable(telegramConnectLinkStatus$);
  const [connectLoadable, connectTelegram] = useLoadableSet(
    connectTelegramAccount$,
  );
  const pageSignal = useGet(pageSignal$);
  const connecting = connectLoadable.state === "loading";
  const success =
    connectLoadable.state === "hasData" ? connectLoadable.data : null;
  const error =
    connectLoadable.state === "hasError"
      ? getTelegramConnectErrorMessage(connectLoadable.error)
      : null;

  if (!parsed.ok) {
    return <InvalidTelegramConnectParams code={parsed.error.code} />;
  }

  if (clerkLoadable.state === "loading") {
    return <TelegramSessionLoadingState brandName={brandName} />;
  }

  if (clerkLoadable.state === "hasError") {
    return (
      <InvalidState
        title={t(($) => {
          return $.connectors.providerConnect.telegram.signInCheckFailed;
        })}
        message={t(($) => {
          return $.connectors.providerConnect.telegram.refresh;
        })}
      />
    );
  }

  if (!clerkLoadable.data.user) {
    return <TelegramSignInState brandName={brandName} />;
  }

  if (success) {
    return <SuccessState botUsername={success.botUsername} />;
  }

  if (linkStatusLoadable.state === "loading") {
    return <TelegramConnectionLoadingState />;
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
        title={t(($) => {
          return $.connectors.providerConnect.telegram.connectTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.telegram.connectDescription;
        })}
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
          connecting={connecting}
          onConnect={() => {
            detach(connectTelegram(pageSignal), Reason.DomCallback);
          }}
        />
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}
