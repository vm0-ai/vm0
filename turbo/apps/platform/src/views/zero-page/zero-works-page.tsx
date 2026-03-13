import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconCircleCheck,
  IconDotsVertical,
  IconDownload,
} from "@tabler/icons-react";
import { Button, Input } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  slackOrgData$,
  disconnectSlackOrg$,
  uninstallSlackOrg$,
} from "../../signals/zero-page/zero-slack.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function ZeroWorksPage() {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const search$ = useCCState("");
  const search = useGet(search$);
  const setSearch = useSet(search$);
  const slackData = useGet(slackOrgData$);
  const disconnect = useSet(disconnectSlackOrg$);
  const uninstall = useSet(uninstallSlackOrg$);

  const isConnected = slackData?.isConnected ?? false;
  const isInstalled = slackData?.isInstalled ?? isConnected;
  const isAdmin = slackData?.isAdmin ?? false;
  const installUrl = slackData?.installUrl;
  const connectUrl = slackData?.connectUrl;

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
          <div className="mt-4 relative">
            <IconSearch
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              size={16}
              stroke={1.5}
            />
            <Input
              placeholder="Search tools..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="zero-search-input pl-9 h-9 rounded-lg border"
            />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <div className="zero-card flex items-center gap-4 p-4">
            <div className="shrink-0">
              <img src="/slack-icon.svg" alt="" className="h-7 w-7" />
            </div>
            <div className="flex flex-1 flex-col gap-1 min-w-0">
              <div className="text-sm font-medium text-foreground">
                Slack
                {isConnected && slackData?.workspaceName && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    ({slackData.workspaceName})
                  </span>
                )}
              </div>
              <div className="text-sm text-muted-foreground">
                {!isInstalled && !isAdmin
                  ? "Ask your admin to install the Slack integration"
                  : "Team communication and collaboration"}
              </div>
            </div>
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
            {isInstalled && (
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
                      onClick={() => {
                        detach(disconnect(), Reason.DomCallback);
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                  {isAdmin && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                      onClick={() => {
                        detach(uninstall(), Reason.DomCallback);
                      }}
                    >
                      Uninstall
                    </button>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
