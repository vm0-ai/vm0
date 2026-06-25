import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconCheck,
  IconDeviceDesktop,
  IconDownload,
  IconLoader2,
} from "@tabler/icons-react";
import type { ComputerUseHost } from "@vm0/api-contracts/contracts/zero-computer-use";
import { Button } from "@vm0/ui/components/ui/button";
import {
  applyComputerUseAuthorizationRequest$,
  computerUseAuthorizationRequest$,
} from "../../signals/computer-use-authorization/computer-use-authorization.ts";
import {
  visibleComputerUseHosts,
  ZERO_DESKTOP_DOWNLOAD_URL,
} from "../../signals/zero-page/computer-use-hosts.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import computerUseIllustration from "../zero-page/assets/computer-use-illustration.png";
import { Vm0LogoLink } from "../zero-page/zero-directed-shared.tsx";

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function sourceLabel(source: "chat" | "slack"): string {
  return source === "slack" ? "this Slack thread" : "this chat thread";
}

function HostOption({
  host,
  disabled,
  applying,
  applied,
  onAuthorize,
}: {
  host: ComputerUseHost;
  disabled: boolean;
  applying: boolean;
  applied: boolean;
  onAuthorize: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <IconDeviceDesktop size={18} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {host.displayName}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Last seen {formatTime(host.lastSeenAt)}
          </div>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={onAuthorize}
        className="h-9 w-full shrink-0 sm:w-auto"
      >
        {applying && <IconLoader2 size={16} className="animate-spin" />}
        {applied ? (
          <>
            <IconCheck size={16} />
            Authorized
          </>
        ) : (
          "Authorize"
        )}
      </Button>
    </div>
  );
}

function EmptyHosts() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-muted/30 px-4 py-6 text-center">
      <div className="flex h-24 w-24 items-center justify-center">
        <img
          src={computerUseIllustration}
          alt=""
          className="h-24 w-24 object-contain"
        />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">
          No online computers
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          Open Zero Computer Use on your Mac and refresh this page when it comes
          online.
        </p>
      </div>
      <a
        href={ZERO_DESKTOP_DOWNLOAD_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        <IconDownload size={16} />
        Download for macOS
      </a>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center px-4">
      <div className="flex w-[430px] max-w-full flex-col items-center gap-6 rounded-xl border border-border bg-background px-6 py-10 text-center">
        <Vm0LogoLink />
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-medium text-foreground">
            Authorization link unavailable
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            This Computer Use authorization link is invalid, expired, or not
            available for this workspace.
          </p>
        </div>
      </div>
    </div>
  );
}

export function ComputerUseAuthorizationPage() {
  const pageSignal = useGet(pageSignal$);
  const requestLoadable = useLoadable(computerUseAuthorizationRequest$);
  const [applyLoadable, applyAuthorization] = useLoadableSet(
    applyComputerUseAuthorizationRequest$,
  );
  const request =
    requestLoadable.state === "hasData" ? requestLoadable.data : null;
  const hosts = request?.hosts;
  const visibleHosts = visibleComputerUseHosts(hosts ?? [], null);

  if (requestLoadable.state === "loading") {
    return (
      <div className="fixed inset-0 z-10 flex items-center justify-center">
        <IconLoader2 size={22} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (requestLoadable.state === "hasError" || !request) {
    return <ErrorState />;
  }

  const applying = applyLoadable.state === "loading";
  const applied =
    applyLoadable.state === "hasData" || Boolean(request.completedAt);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center overflow-y-auto px-4 py-8">
      <div className="flex w-[520px] max-w-full flex-col gap-6 rounded-xl border border-border bg-background px-6 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <Vm0LogoLink />
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
            <IconDeviceDesktop size={22} />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-medium text-foreground">
              Authorize computer use
            </h1>
            <p className="mx-auto max-w-md text-sm leading-5 text-muted-foreground">
              Choose an online computer for Zero to use in{" "}
              {sourceLabel(request.source)}.
            </p>
          </div>
        </div>

        {visibleHosts.length === 0 ? (
          <EmptyHosts />
        ) : (
          <div className="flex flex-col gap-3">
            {visibleHosts.map((host) => {
              return (
                <HostOption
                  key={host.id}
                  host={host}
                  disabled={applying || applied}
                  applying={applying}
                  applied={applied}
                  onAuthorize={() => {
                    detach(
                      applyAuthorization(host, pageSignal),
                      Reason.DomCallback,
                    );
                  }}
                />
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <div className="text-xs text-muted-foreground">
            Link expires {formatTime(request.expiresAt)}.
          </div>
        </div>
      </div>
    </div>
  );
}
