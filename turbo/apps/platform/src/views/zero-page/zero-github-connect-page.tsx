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
import { clerk$, resolveWebOrigin } from "../../signals/auth.ts";
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
import githubIconImg from "./components/settings/icons/github.svg";

function signInHref(): string {
  const webOrigin = resolveWebOrigin();
  const signInPath = `${webOrigin}/sign-in`;
  return `${signInPath}?redirect_url=${encodeURIComponent(location.href)}`;
}

function BackLink() {
  return (
    <Link
      pathname="/settings/github"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <IconArrowLeft size={14} />
      Back to GitHub settings
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
  return normalized ? `@${normalized}` : "this GitHub account";
}

function getGithubConnectErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "We couldn't connect GitHub. Try again from GitHub.";
}

function SuccessState({ githubUsername }: { githubUsername?: string }) {
  return (
    <PageShell>
      <GithubMark state="success" />
      <CenterText
        title="Connected to GitHub!"
        body={
          <>
            You&apos;re connected as{" "}
            <span className="font-medium">
              {githubUserLabel(githubUsername)}
            </span>
            . Mention your agent in GitHub issues or pull requests to start
            chatting.
          </>
        }
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
  return (
    <PageShell>
      <GithubMark state="success" />
      <CenterText
        title="Already connected to GitHub"
        body={
          <>
            You&apos;re already connected as{" "}
            <span className="font-medium">
              {githubUserLabel(githubUsername)}
            </span>
            . Mention your agent in GitHub issues or pull requests to start
            chatting.
          </>
        }
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
  return (
    <PageShell>
      <GithubMark />
      <CenterText
        title="Sign in to continue"
        body="Use your VM0 account before connecting this GitHub user."
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
  return (
    <PageShell>
      <GithubMark />
      <CenterText
        title="Connect to GitHub"
        body={
          <>
            Link your VM0 account to{" "}
            <span className="font-medium">
              {githubUserLabel(params.githubUsername)}
            </span>{" "}
            so GitHub mentions can run your agents from issues and pull
            requests.
          </>
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
        <Button className="w-full" disabled={connecting} onClick={onConnect}>
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

export function ZeroGithubConnectPage(): JSX.Element {
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
    return (
      <InvalidState title={parsed.error.title} message={parsed.error.message} />
    );
  }

  if (clerkLoadable.state === "loading") {
    return (
      <LoadingState
        title="Checking account status..."
        body="Please wait while we verify your VM0 session."
      />
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
    return <SignInState />;
  }

  if (success) {
    return <SuccessState githubUsername={success.githubUsername} />;
  }

  if (linkStatusLoadable.state === "loading") {
    return (
      <LoadingState
        title="Checking connection..."
        body="Please wait while we check your GitHub connection."
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
        title="GitHub is not installed"
        message="Ask an organization admin to install GitHub before connecting your account."
      />
    );
  }
  if (linkStatus?.kind === "wrong_organization") {
    return (
      <InvalidState
        title="Switch organization"
        message="Your active organization doesn't match this GitHub installation. Switch to the correct organization and open the link again."
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
