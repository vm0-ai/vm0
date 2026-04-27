"use client";

import { useAuth } from "@clerk/nextjs";
import type {
  TelegramConnectParamError,
  TelegramConnectParams,
} from "./connect-params";
import { useState } from "react";

interface TelegramConnectClientProps {
  params: TelegramConnectParams | null;
  paramError: TelegramConnectParamError | null;
  returnPath: string;
}

interface TelegramConnectSuccess {
  botUsername: string;
  telegramUserId: string;
}

interface TelegramConnectErrorResponse {
  error?: {
    message?: string;
  };
}

function signInHref(returnPath: string): string {
  return `/sign-in?redirect_url=${encodeURIComponent(returnPath)}`;
}

async function linkTelegramAccount(
  params: TelegramConnectParams,
  token: string,
): Promise<TelegramConnectSuccess> {
  const response = await fetch("/api/integrations/telegram/link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      telegramBotId: params.telegramBotId,
      connectSignature: {
        telegramUserId: params.telegramUserId,
        timestamp: params.timestamp,
        signature: params.signature,
      },
    }),
  });

  const body = (await response.json().catch(() => {
    return {};
  })) as TelegramConnectSuccess | TelegramConnectErrorResponse;

  if (!response.ok) {
    const message =
      "error" in body && body.error?.message
        ? body.error.message
        : "We couldn't connect Telegram. Try again from Telegram.";
    throw new Error(message);
  }

  if (!("botUsername" in body) || !("telegramUserId" in body)) {
    throw new Error("Telegram connected, but the response was incomplete.");
  }

  return body;
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-[420px] rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <p className="text-sm font-medium text-muted-foreground">VM0</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal">
            Connect Telegram
          </h1>
        </div>
        {children}
      </section>
    </main>
  );
}

function MessageState({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-background p-4">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {message}
        </p>
      </div>
      {children}
    </div>
  );
}

export function TelegramConnectClient({
  params,
  paramError,
  returnPath,
}: TelegramConnectClientProps): React.JSX.Element {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<TelegramConnectSuccess | null>(null);

  if (paramError || !params) {
    return (
      <PageShell>
        <MessageState
          title={paramError?.title ?? "Connect link is invalid"}
          message={
            paramError?.message ??
            "Open a fresh /connect link from Telegram and try again."
          }
        />
      </PageShell>
    );
  }

  if (!isLoaded) {
    return (
      <PageShell>
        <MessageState
          title="Checking sign-in"
          message="Hold on while we check your VM0 session."
        />
      </PageShell>
    );
  }

  if (!isSignedIn) {
    return (
      <PageShell>
        <MessageState
          title="Sign in to continue"
          message="Use your VM0 account before connecting this Telegram user."
        >
          <a
            href={signInHref(returnPath)}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Sign in to VM0
          </a>
        </MessageState>
      </PageShell>
    );
  }

  if (success) {
    const telegramHref = `https://t.me/${success.botUsername.replace(/^@/, "")}`;
    return (
      <PageShell>
        <MessageState
          title="Telegram connected"
          message={`Telegram user ${success.telegramUserId} is now linked to your VM0 account.`}
        >
          <a
            href={telegramHref}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:bg-muted"
            rel="noreferrer"
            target="_blank"
          >
            Open Telegram
          </a>
        </MessageState>
      </PageShell>
    );
  }

  const confirm = () => {
    setLoading(true);
    setError(null);
    getToken()
      .then((token) => {
        if (!token) {
          throw new Error("Sign in again before connecting Telegram.");
        }
        return linkTelegramAccount(params, token);
      })
      .then((result) => {
        setSuccess(result);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? err.message
            : "We couldn't connect Telegram. Try again from Telegram.",
        );
      })
      .finally(() => {
        setLoading(false);
      });
  };

  return (
    <PageShell>
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-6 text-muted-foreground">
          Confirm that Telegram user {params.telegramUserId} should connect to
          your VM0 account.
        </p>
        {error && (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        )}
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading}
          onClick={confirm}
        >
          {loading ? "Connecting..." : "Connect Telegram"}
        </button>
      </div>
    </PageShell>
  );
}
