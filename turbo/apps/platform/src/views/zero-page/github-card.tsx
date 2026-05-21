import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconCircleCheck, IconDotsVertical } from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  connectGithubInstallation$,
  disconnectGithubInstallation$,
  githubIntegrationData$,
  uninstallGithubInstallation$,
  type GithubIntegrationData,
} from "../../signals/zero-page/zero-github.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import githubIconImg from "./components/settings/icons/github.svg";

function openFreshOAuth(url: string) {
  const fresh = new URL(url, window.location.origin);
  fresh.searchParams.set("_t", String(Date.now()));
  window.open(fresh.toString(), "_blank");
}

function formatGithubUsername(
  username: string | null | undefined,
): string | null {
  const trimmed = username?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function GithubConnectedBadge({
  connected,
  username,
}: {
  readonly connected: boolean;
  readonly username: string | null | undefined;
}) {
  if (!connected) {
    return null;
  }

  const connectedDetail = formatGithubUsername(username);

  return (
    <span
      data-testid="github-connected-indicator"
      className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
    >
      <IconCircleCheck className="h-3 w-3 text-green-600" />
      <span className="min-w-0 truncate">
        {connectedDetail ? `Connected (${connectedDetail})` : "Connected"}
      </span>
    </span>
  );
}

function GithubOptionsPopover({
  canUninstall,
  disconnecting,
  isConnected,
  uninstalling,
  onDisconnect,
  onUninstall,
}: {
  readonly canUninstall: boolean;
  readonly disconnecting: boolean;
  readonly isConnected: boolean;
  readonly uninstalling: boolean;
  readonly onDisconnect: () => void;
  readonly onUninstall: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="GitHub options"
        >
          <IconDotsVertical size={16} stroke={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-44 flex-col gap-0.5 p-2">
        <Link
          pathname={ROUTES.settingsGithub}
          aria-label="Manage GitHub"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground no-underline transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Manage
        </Link>
        {isConnected ? (
          <button
            type="button"
            disabled={disconnecting}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onDisconnect}
          >
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </button>
        ) : null}
        {canUninstall ? (
          <button
            type="button"
            disabled={uninstalling}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onUninstall}
          >
            {uninstalling ? "Uninstalling..." : "Uninstall"}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function GithubCardActions({
  data,
}: {
  readonly data: GithubIntegrationData | null;
}) {
  const pageSignal = useGet(pageSignal$);
  const [connectLoadable, connect] = useLoadableSet(connectGithubInstallation$);
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectGithubInstallation$,
  );
  const [uninstallLoadable, uninstall] = useLoadableSet(
    uninstallGithubInstallation$,
  );
  const connecting = connectLoadable.state === "loading";
  const disconnecting = disconnectLoadable.state === "loading";
  const uninstalling = uninstallLoadable.state === "loading";
  const busy = connecting || disconnecting || uninstalling;
  const isInstalled = data?.isInstalled ?? false;
  const isConnected = data?.isConnected ?? false;
  const installUrl = isInstalled ? null : data?.installUrl;
  const connectUrl = data?.connectUrl ?? null;
  const canUninstall = Boolean(data?.isInstalled && data.installation.isAdmin);

  if (installUrl) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1.5 rounded-lg"
        disabled={busy}
        onClick={() => {
          openFreshOAuth(installUrl);
        }}
      >
        Install GitHub
      </Button>
    );
  }

  if (!isInstalled) {
    return null;
  }

  return (
    <>
      {!isConnected && connectUrl ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          disabled={busy}
          onClick={() => {
            detach(connect(connectUrl, pageSignal), Reason.DomCallback);
          }}
        >
          {connecting ? "Connecting..." : "Connect"}
        </Button>
      ) : null}
      <GithubOptionsPopover
        canUninstall={canUninstall}
        disconnecting={disconnecting}
        isConnected={isConnected}
        uninstalling={uninstalling}
        onDisconnect={() => {
          detach(disconnect(pageSignal), Reason.DomCallback);
        }}
        onUninstall={() => {
          detach(uninstall(pageSignal), Reason.DomCallback);
        }}
      />
    </>
  );
}

export function GithubCard() {
  const dataLoadable = useLastLoadable(githubIntegrationData$);
  const data = dataLoadable.state === "hasData" ? dataLoadable.data : null;

  return (
    <div className="zero-card flex flex-col">
      <div className="flex items-center gap-4 p-4">
        <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
          <img src={githubIconImg} alt="" className="h-7 w-7" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-sm font-medium text-foreground">GitHub</div>
          <div className="truncate text-sm text-muted-foreground">
            Run agents from GitHub issue and PR labels
          </div>
        </div>
        <GithubConnectedBadge
          connected={data?.isConnected ?? false}
          username={data?.connectedGithubUsername}
        />
        <GithubCardActions data={data} />
      </div>
    </div>
  );
}
