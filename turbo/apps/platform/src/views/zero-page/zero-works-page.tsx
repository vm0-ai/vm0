import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
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
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  slackOrgData$,
  disconnectSlackOrg$,
  uninstallSlackOrg$,
} from "../../signals/zero-page/zero-slack.ts";
import { detach, Reason } from "../../signals/utils.ts";

function SlackCardActions({
  isConnected,
  isInstalled,
  isAdmin,
  installUrl,
  connectUrl,
  onDisconnect,
  onUninstall,
}: {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  installUrl: string | null | undefined;
  connectUrl: string | null | undefined;
  onDisconnect: () => void;
  onUninstall: () => void;
}) {
  return (
    <>
      {isConnected ? (
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
          <IconCircleCheck className="h-3 w-3 text-green-600" />
          Connected
        </span>
      ) : null}
      {!isInstalled && isAdmin && installUrl && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => window.open(installUrl, "_blank")}
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
          onClick={() => window.open(connectUrl, "_blank")}
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
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onDisconnect}
              >
                Disconnect
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
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

function SlackCard({ agentName }: { agentName: string }) {
  const slackData = useGet(slackOrgData$);
  const disconnect = useSet(disconnectSlackOrg$);
  const uninstall = useSet(uninstallSlackOrg$);

  const showUninstallDialog$ = useCCState(false);
  const showUninstallDialog = useGet(showUninstallDialog$);
  const setShowUninstallDialog = useSet(showUninstallDialog$);

  const isConnected = slackData?.isConnected ?? false;
  const isInstalled = slackData?.isInstalled ?? isConnected;
  const isAdmin = slackData?.isAdmin ?? false;

  return (
    <>
      <div className="zero-card flex items-center gap-4 p-4">
        <div className="shrink-0">
          <img src="/slack-icon.svg" alt="" className="h-7 w-7" />
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
          onDisconnect={() => detach(disconnect(), Reason.DomCallback)}
          onUninstall={() => setShowUninstallDialog(true)}
        />
      </div>

      <Dialog open={showUninstallDialog} onOpenChange={setShowUninstallDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall Slack integration?</DialogTitle>
            <DialogDescription>
              This will remove the Slack integration for your entire workspace.
              All connected users will be disconnected and {agentName} will no
              longer respond to messages or mentions in Slack. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowUninstallDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowUninstallDialog(false);
                detach(uninstall(), Reason.DomCallback);
              }}
            >
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ZeroWorksPage() {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Where {agentName} works
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect with {agentName} through these channels
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <SlackCard agentName={agentName} />
        </div>
      </main>
    </div>
  );
}
