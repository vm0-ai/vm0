import { useGet, useLastLoadable, useLoadable } from "ccstate-react";
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
import { clerk$, resolveAppAuthUrl } from "../../signals/auth.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectGithubMentionAccount$,
  githubConnectLinkStatus$,
} from "../../signals/zero-page/github-connect-signals.ts";
import {
  parseGithubConnectParams,
  type GithubConnectParams,
} from "../../signals/zero-page/github-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const githubIconImg = settingsIconAssetUrl("github");

function signInHref(): string {
  return resolveAppAuthUrl("/sign-in", { redirectUrl: location.href });
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      pathname="/workflows"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      {t(($) => {
        return $.connectors.providerConnect.github.back;
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

function GithubMark({
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
    <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-muted">
      <img src={githubIconImg} alt="" className="h-8 w-8" />
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
      <GithubMark state="error" />
      <CenterText title={title} body={message} />
      <BackLink />
    </PageShell>
  );
}

function githubUserLabel(username: string | undefined): string {
  const normalized = username?.trim().replace(/^@+/, "");
  return normalized
    ? `@${normalized}`
    : i18n.t(($) => {
        return $.connectors.providerConnect.github.accountFallback;
      });
}

function getGithubConnectErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : i18n.t(($) => {
        return $.connectors.providerConnect.github.errorFallback;
      });
}

function SuccessState({ githubUsername }: { githubUsername?: string }) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <GithubMark state="success" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.github.successTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.github.successDescription;
          },
          { account: githubUserLabel(githubUsername) },
        )}
      />
      <BackLink />
    </PageShell>
  );
}

function AlreadyConnectedState({
  githubUsername,
}: {
  githubUsername?: string;
}) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <GithubMark state="success" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.github.alreadyTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.github.alreadyDescription;
          },
          { account: githubUserLabel(githubUsername) },
        )}
      />
      <BackLink />
    </PageShell>
  );
}

function LoadingState({
  title,
  body,
}: {
  title: string;
  body: string;
}): JSX.Element {
  return (
    <PageShell>
      <GithubMark state="loading" />
      <CenterText title={title} body={body} />
    </PageShell>
  );
}

function SignInState(): JSX.Element {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

  return (
    <PageShell>
      <GithubMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.github.signInTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.github.signInDescription;
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
            return $.connectors.providerConnect.github.signInButton;
          },
          { brandName },
        )}
      </a>
    </PageShell>
  );
}

function ConnectState({
  params,
  error,
  connecting,
  onConnect,
}: {
  params: GithubConnectParams;
  error: string | null;
  connecting: boolean;
  onConnect: () => void;
}): JSX.Element {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

  return (
    <PageShell>
      <GithubMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.github.connectTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.github.connectDescription;
          },
          {
            account: githubUserLabel(params.githubUsername),
            brandName,
          },
        )}
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
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}

type GithubConnectParamErrorCode = Extract<
  ReturnType<typeof parseGithubConnectParams>,
  { ok: false }
>["error"]["code"];

function InvalidGithubConnectParams({
  code,
}: {
  code: GithubConnectParamErrorCode;
}) {
  const { t } = useTranslation();
  const title =
    code === "incomplete"
      ? t(($) => {
          return $.connectors.providerConnect.github.linkIncompleteTitle;
        })
      : t(($) => {
          return $.connectors.providerConnect.github.invalidTitle;
        });
  const messages: Record<GithubConnectParamErrorCode, string> = {
    incomplete: t(($) => {
      return $.connectors.providerConnect.github.linkIncomplete;
    }),
    invalid_installation: t(($) => {
      return $.connectors.providerConnect.github.invalidInstallation;
    }),
    invalid_signature: t(($) => {
      return $.connectors.providerConnect.github.invalidSignature;
    }),
    invalid_timestamp: t(($) => {
      return $.connectors.providerConnect.github.invalidTimestamp;
    }),
    invalid_user: t(($) => {
      return $.connectors.providerConnect.github.invalidUser;
    }),
    invalid_username: t(($) => {
      return $.connectors.providerConnect.github.invalidUsername;
    }),
  };
  return <InvalidState title={title} message={messages[code]} />;
}

export function ZeroGithubConnectPage(): JSX.Element {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const params = useGet(searchParams$);
  const parsed = parseGithubConnectParams(params);
  const clerkLoadable = useLoadable(clerk$);
  const linkStatusLoadable = useLastLoadable(githubConnectLinkStatus$);
  const [connectLoadable, connectGithub] = useLoadableSet(
    connectGithubMentionAccount$,
  );
  const pageSignal = useGet(pageSignal$);
  const connecting = connectLoadable.state === "loading";
  const success =
    connectLoadable.state === "hasData" ? connectLoadable.data : null;
  const error =
    connectLoadable.state === "hasError"
      ? getGithubConnectErrorMessage(connectLoadable.error)
      : null;

  if (!parsed.ok) {
    return <InvalidGithubConnectParams code={parsed.error.code} />;
  }

  if (clerkLoadable.state === "loading") {
    return (
      <LoadingState
        title={t(($) => {
          return $.connectors.providerConnect.common.checkingTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.github.checkingSession;
          },
          { brandName },
        )}
      />
    );
  }

  if (clerkLoadable.state === "hasError") {
    return (
      <InvalidState
        title={t(($) => {
          return $.connectors.providerConnect.github.signInCheckFailed;
        })}
        message={t(($) => {
          return $.connectors.providerConnect.github.refresh;
        })}
      />
    );
  }

  if (!clerkLoadable.data.user) {
    return <SignInState />;
  }

  if (success) {
    return <SuccessState githubUsername={success.githubUsername} />;
  }

  if (linkStatusLoadable.state === "loading") {
    return (
      <LoadingState
        title={t(($) => {
          return $.connectors.providerConnect.github.checkingConnectionTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.github
            .checkingConnectionDescription;
        })}
      />
    );
  }

  const linkStatus =
    linkStatusLoadable.state === "hasData" ? linkStatusLoadable.data : null;
  if (linkStatus?.kind === "already_connected") {
    return (
      <AlreadyConnectedState
        githubUsername={
          linkStatus.githubUsername ?? parsed.params.githubUsername
        }
      />
    );
  }
  if (linkStatus?.kind === "not_installed") {
    return (
      <InvalidState
        title={t(($) => {
          return $.connectors.providerConnect.github.notInstalledTitle;
        })}
        message={t(($) => {
          return $.connectors.providerConnect.github.notInstalledDescription;
        })}
      />
    );
  }
  if (linkStatus?.kind === "wrong_organization") {
    return (
      <InvalidState
        title={t(($) => {
          return $.connectors.providerConnect.github.wrongOrganizationTitle;
        })}
        message={t(($) => {
          return $.connectors.providerConnect.github
            .wrongOrganizationDescription;
        })}
      />
    );
  }

  return (
    <ConnectState
      params={parsed.params}
      error={error}
      connecting={connecting}
      onConnect={() => {
        detach(connectGithub(pageSignal), Reason.DomCallback);
      }}
    />
  );
}
