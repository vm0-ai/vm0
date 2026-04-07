import { useGet, useSet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDotsVertical,
  IconDownload,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { currentChatAgentDisplayName$ } from "../../signals/agent-chat.ts";
import {
  slackOrgData$,
  disconnectSlackOrg$,
  uninstallSlackOrg$,
  showUninstallDialog$,
  setShowUninstallDialog$,
} from "../../signals/zero-page/zero-slack.ts";
import { detach, Reason } from "../../signals/utils.ts";
import slackIconImg from "./assets/slack-icon.svg";

/** Append a cache-busting timestamp so the browser never reuses a cached OAuth redirect. */
function openFreshOAuth(url: string) {
  const fresh = new URL(url, window.location.origin);
  fresh.searchParams.set("_t", String(Date.now()));
  window.open(fresh.toString(), "_blank");
}

function SlackCardActions({
  isConnected,
  isInstalled,
  isAdmin,
  installUrl,
  connectUrl,
  onDisconnect,
  onUninstall,
  disconnecting,
}: {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  installUrl: string | null | undefined;
  connectUrl: string | null | undefined;
  onDisconnect: () => void;
  onUninstall: () => void;
  disconnecting: boolean;
}) {
  return (
    <>
      {isConnected ? (
        <span
          data-testid="slack-connected-indicator"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
        >
          <IconCircleCheck className="h-3 w-3 text-green-600" />
          Connected
        </span>
      ) : null}
      {!isInstalled && isAdmin && installUrl && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(installUrl);
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          Install to Slack
        </Button>
      )}
      {isInstalled && !isConnected && connectUrl && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(connectUrl);
          }}
        >
          Connect
        </Button>
      )}
      {isInstalled && (isConnected || isAdmin) && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="More options"
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            {isConnected && (
              <button
                type="button"
                aria-label="Disconnect"
                disabled={disconnecting}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                onClick={onDisconnect}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                aria-label="Uninstall"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onUninstall}
              >
                Uninstall
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function SlackCard({ displayName }: { displayName: string }) {
  const slackDataLoadable = useLoadable(slackOrgData$);
  const slackData =
    slackDataLoadable.state === "hasData" ? slackDataLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectSlackOrg$);
  const disconnecting = disconnectLoadable.state === "loading";
  const [uninstallLoadable, uninstall] = useLoadableSet(uninstallSlackOrg$);
  const uninstalling = uninstallLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const showUninstallDialog = useGet(showUninstallDialog$);
  const setShowUninstallDialog = useSet(setShowUninstallDialog$);

  const isConnected = slackData?.isConnected ?? false;
  const isInstalled = slackData?.isInstalled ?? isConnected;
  const isAdmin = slackData?.isAdmin ?? false;
  const scopeMismatch = slackData?.scopeMismatch === true;
  const reinstallUrl = slackData?.reinstallUrl;

  return (
    <>
      <div className="zero-card flex flex-col">
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0">
            <img src={slackIconImg} alt="" className="h-7 w-7" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">Slack</div>
            <div className="text-sm text-muted-foreground">
              {!isInstalled && !isAdmin
                ? "Ask your admin to install the Slack integration"
                : "Team communication and collaboration"}
            </div>
          </div>
          <SlackCardActions
            isConnected={isConnected}
            isInstalled={isInstalled}
            isAdmin={isAdmin}
            installUrl={slackData?.installUrl}
            connectUrl={slackData?.connectUrl}
            disconnecting={disconnecting}
            onDisconnect={() => {
              return detach(disconnect(pageSignal), Reason.DomCallback);
            }}
            onUninstall={() => {
              return setShowUninstallDialog(true);
            }}
          />
        </div>

        {scopeMismatch && isAdmin && reinstallUrl && (
          <div className="flex items-center gap-3 border-t border-border/50 px-4 py-3">
            <IconAlertTriangle size={16} className="shrink-0 text-amber-500" />
            <span className="flex-1 text-sm text-amber-600 dark:text-amber-400">
              Slack permissions have been updated
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-xs"
              onClick={() => {
                return openFreshOAuth(reinstallUrl);
              }}
            >
              Update Permissions
            </Button>
          </div>
        )}
      </div>

      <Dialog
        open={showUninstallDialog}
        onOpenChange={(v) => {
          if (!uninstalling) {
            setShowUninstallDialog(v);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall Slack integration?</DialogTitle>
            <DialogDescription>
              This will remove the Slack integration for your entire workspace.
              All connected users will be disconnected and {displayName} will no
              longer respond to messages or mentions in Slack. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={uninstalling}
              onClick={() => {
                return setShowUninstallDialog(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={uninstalling}
              onClick={() => {
                detach(
                  uninstall(pageSignal).then(() => {
                    setShowUninstallDialog(false);
                  }),
                  Reason.DomCallback,
                );
              }}
            >
              {uninstalling ? "Uninstalling…" : "Uninstall"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ZeroWorksPage() {
  const displayNameLoadable = useLoadable(currentChatAgentDisplayName$);
  const displayName =
    displayNameLoadable.state === "hasData"
      ? (displayNameLoadable.data ?? "Zero")
      : "Zero";

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="hidden md:block text-lg font-semibold tracking-tight text-foreground">
            Where {displayName} works
          </h1>
          <p className="hidden md:block mt-0.5 text-sm text-muted-foreground">
            Connect with {displayName} through these channels
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <SlackCard displayName={displayName} />
        </div>
      </main>
    </div>
  );
}
