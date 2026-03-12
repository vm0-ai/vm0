import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconUser,
  IconUsers,
  IconTrash,
  IconDotsVertical,
  IconMessageCircle,
} from "@tabler/icons-react";
import {
  Button,
  Card,
  CardContent,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { ZeroJobDetailPage, type JobItem } from "./zero-job-detail-page.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  setPendingChatPrompt$,
  setZeroActiveId$,
} from "../../signals/zero-page/zero-nav.ts";

export const ZERO_TEAM_JOBS: readonly Readonly<JobItem>[] = [
  {
    id: "1",
    title: "Aria",
    avatar: "/avatars/avatar-1.png",
    description: "Get a daily summary of your team's important updates.",
    scope: "team",
  },
  {
    id: "2",
    title: "Rex",
    avatar: "/avatars/avatar-2.png",
    description: "Automatically categorize and prioritize new GitHub issues.",
    scope: "personal",
  },
  {
    id: "3",
    title: "Nova",
    avatar: "/avatars/avatar-3.png",
    description: "Receive a weekly summary of your team's achievements.",
    scope: "team",
  },
  {
    id: "4",
    title: "Sage",
    avatar: "/avatars/avatar-4.png",
    description: "Compile and analyze customer feedback from multiple sources.",
    scope: "personal",
  },
];

export function ZeroJobsPage({
  onNavigateToChat,
}: {
  onNavigateToChat?: () => void;
} = {}) {
  const setPrompt = useSet(setPendingChatPrompt$);
  const navigateToChat = useSet(setZeroActiveId$);
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const selectedJobId$ = useCCState<string | null>(null);
  const selectedJobId = useGet(selectedJobId$);
  const setSelectedJobId = useSet(selectedJobId$);

  const selectedJob = selectedJobId
    ? ZERO_TEAM_JOBS.find((j) => j.id === selectedJobId)
    : null;

  if (selectedJob) {
    return (
      <ZeroJobDetailPage
        job={selectedJob}
        onBack={() => setSelectedJobId(null)}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px] flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {agentName}&apos;s sub agents
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Sub-agents created by {agentName} to run tailored workflows for
              you and your team.
            </p>
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border px-4"
                  onClick={() => {
                    setPrompt(
                      "I want to create a new sub-agent to handle a specific workflow for my team",
                    );
                    if (onNavigateToChat) {
                      onNavigateToChat();
                    } else {
                      navigateToChat("chat");
                    }
                  }}
                >
                  <IconMessageCircle size={14} stroke={1.5} />
                  Create sub agent
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="max-w-[220px] text-center"
              >
                Chat with {agentName} to create a sub-agent
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          {ZERO_TEAM_JOBS.map((job) => (
            <Card
              key={job.id}
              role="button"
              tabIndex={0}
              className="zero-card cursor-pointer hover:border-border transition-colors"
              onClick={() => setSelectedJobId(job.id)}
              onKeyDown={(e) => e.key === "Enter" && setSelectedJobId(job.id)}
            >
              <CardContent className="px-6 py-4">
                <div className="flex items-center gap-4">
                  <img
                    src={job.avatar}
                    alt={job.title}
                    className="h-9 w-9 shrink-0 rounded-full object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold tracking-tight text-foreground">
                        {job.title}
                      </h2>
                      <span className="zero-pill inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs font-medium">
                        {job.scope === "team" ? (
                          <IconUsers
                            size={12}
                            stroke={1.5}
                            className="h-3 w-3 shrink-0 text-sky-600 dark:text-sky-400"
                          />
                        ) : (
                          <IconUser
                            size={12}
                            stroke={1.5}
                            className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                          />
                        )}
                        {job.scope === "team" ? "Team" : "Personal"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground truncate">
                      {job.description}
                    </p>
                  </div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Agent actions"
                      >
                        <IconDotsVertical size={16} stroke={1.5} />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      className="flex flex-col gap-0.5 w-40 p-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                      >
                        <IconTrash size={14} stroke={1.5} />
                        Delete
                      </button>
                    </PopoverContent>
                  </Popover>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    </div>
  );
}
