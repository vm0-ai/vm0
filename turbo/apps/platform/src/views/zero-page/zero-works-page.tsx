import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconSettings,
  IconCircleCheck,
  IconDotsVertical,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Input,
} from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { ZeroSlackConfigContent } from "./zero-slack-config-content";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";

const CONNECTED_TOOLS: readonly Readonly<{
  id: string;
  name: string;
  description: string;
}>[] = [
  {
    id: "slack",
    name: "Slack",
    description: "Team communication and collaboration",
  },
];

export function ZeroWorksPage() {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const search$ = useCCState("");
  const search = useGet(search$);
  const setSearch = useSet(search$);
  const slackConfigOpen$ = useCCState(false);
  const slackConfigOpen = useGet(slackConfigOpen$);
  const setSlackConfigOpen = useSet(slackConfigOpen$);

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
          {CONNECTED_TOOLS.map((tool) => (
            <div
              key={tool.id}
              className="zero-card flex items-center gap-4 p-4"
            >
              <div className="shrink-0">
                <img src="/slack-icon.svg" alt="" className="h-7 w-7" />
              </div>
              <div className="flex flex-1 flex-col gap-1 min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {tool.name}
                </div>
                <div className="text-sm text-muted-foreground">
                  {tool.description}
                </div>
              </div>
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
                <IconCircleCheck className="h-3 w-3 text-green-600" />
                Connected
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 rounded-lg"
                onClick={() => tool.id === "slack" && setSlackConfigOpen(true)}
              >
                <IconSettings size={14} stroke={1.5} />
                Configure
              </Button>
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
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    Disconnect
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          ))}
        </div>
      </main>

      <Dialog open={slackConfigOpen} onOpenChange={setSlackConfigOpen}>
        <DialogContent className="max-w-[600px] max-h-[90vh] flex flex-col p-0 gap-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
            <DialogTitle>VM0 in Slack</DialogTitle>
            <DialogDescription>
              Configure your settings how to run VM0 in Slack Workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
            <ZeroSlackConfigContent
              onAfterDisconnect={() => setSlackConfigOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
