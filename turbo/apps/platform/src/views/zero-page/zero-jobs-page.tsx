import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconUser,
  IconUsers,
  IconSparkles,
  IconMessageCircle,
} from "@tabler/icons-react";
import { Card, CardContent } from "@vm0/ui";
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
  zeroAvatarSrc = "/zero-avatar.png",
}: {
  onNavigateToChat?: () => void;
  zeroAvatarSrc?: string;
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
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            {agentName}&apos;s team
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {agentName} and sub-agents working together to run tailored
            workflows for you and your team.
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          {/* Zero — full width */}
          <Card
            role="button"
            tabIndex={0}
            className="zero-card cursor-pointer"
            onClick={() => navigateToChat("meet")}
            onKeyDown={(e) => e.key === "Enter" && navigateToChat("meet")}
          >
            <CardContent className="p-5 flex items-center gap-4">
              <img
                src={zeroAvatarSrc}
                alt={agentName}
                className="h-12 w-12 shrink-0 rounded-full object-cover object-top"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold tracking-tight text-foreground truncate">
                    {agentName}
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground">
                    <IconSparkles
                      size={12}
                      stroke={1.5}
                      className="h-3 w-3 shrink-0 text-violet-600 dark:text-violet-400"
                    />
                    Main
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Your primary AI assistant that manages your team and
                  orchestrates workflows.
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="border-t border-border/60" />

          {/* Sub-agents grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <button
              type="button"
              className="flex items-center gap-3 rounded-[var(--zero-card-radius)] border border-dashed border-foreground/20 px-4 py-3.5 transition-colors hover:border-foreground/30 hover:bg-muted/30 group col-span-full"
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
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/8 group-hover:bg-foreground/12 transition-colors">
                <IconMessageCircle
                  size={16}
                  stroke={1.5}
                  className="text-foreground/50 group-hover:text-foreground transition-colors"
                />
              </span>
              <span className="text-sm text-foreground/60 group-hover:text-foreground transition-colors">
                Start a chat to create a new teammate&hellip;
              </span>
            </button>
            {ZERO_TEAM_JOBS.map((job) => (
              <Card
                key={job.id}
                role="button"
                tabIndex={0}
                className="zero-card cursor-pointer flex flex-col"
                onClick={() => setSelectedJobId(job.id)}
                onKeyDown={(e) => e.key === "Enter" && setSelectedJobId(job.id)}
              >
                <CardContent className="p-5 flex flex-col flex-1 gap-3">
                  <span className="self-start inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground">
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
                    {job.scope === "team" ? "Workspace" : "Private"}
                  </span>
                  <div className="flex items-center gap-2.5">
                    <img
                      src={job.avatar}
                      alt={job.title}
                      className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
                    />
                    <h2 className="text-base font-semibold tracking-tight text-foreground truncate">
                      {job.title}
                    </h2>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {job.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
