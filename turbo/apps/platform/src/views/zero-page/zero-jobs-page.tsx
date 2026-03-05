import { useState } from "react";
import {
  IconUser,
  IconUsers,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
  IconCircleCheck,
  IconCircleOff,
  IconDotsVertical,
} from "@tabler/icons-react";
import { Card, CardContent, Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { ZeroJobDetailPage, type JobItem } from "./zero-job-detail-page.tsx";

type JobScope = "all" | "personal" | "team";

const JOBS: JobItem[] = [
  {
    id: "1",
    title: "Daily Digest",
    description: "Get a daily summary of your team's important updates.",
    scope: "team",
    status: "active",
  },
  {
    id: "2",
    title: "GitHub Issue Triage",
    description: "Automatically categorize and prioritize new GitHub issues.",
    scope: "personal",
    status: "active",
  },
  {
    id: "3",
    title: "Weekly Report",
    description: "Receive a weekly summary of your team's achievements.",
    scope: "team",
    status: "paused",
  },
  {
    id: "4",
    title: "Customer Feedback Digest",
    description: "Compile and analyze customer feedback from multiple sources.",
    scope: "personal",
    status: "active",
  },
];

export function ZeroJobsPage() {
  const [filter, setFilter] = useState<JobScope>("all");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const selectedJob = selectedJobId
    ? JOBS.find((j) => j.id === selectedJobId)
    : null;
  const filteredJobs = JOBS.filter(
    (job) => filter === "all" || job.scope === filter,
  );

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
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Jobs
            </h1>
            <p className="text-sm text-muted-foreground">
              Recurring work that Zero handles for your team.
            </p>
          </div>

          <Tabs
            value={filter}
            onValueChange={(v) => setFilter(v as JobScope)}
            className="mt-4 w-full"
          >
            <TabsList className="h-9 w-full sm:w-auto gap-1 bg-muted/60 px-1 py-1">
              <TabsTrigger
                value="all"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                All Jobs
              </TabsTrigger>
              <TabsTrigger
                value="personal"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconUser size={14} stroke={1.5} />
                Personal
              </TabsTrigger>
              <TabsTrigger
                value="team"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconUsers size={14} stroke={1.5} />
                Team
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          {filteredJobs.map((job) => (
            <Card
              key={job.id}
              role="button"
              tabIndex={0}
              className="rounded-2xl border border-border/70 bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)] cursor-pointer hover:border-border transition-colors"
              onClick={() => setSelectedJobId(job.id)}
              onKeyDown={(e) => e.key === "Enter" && setSelectedJobId(job.id)}
            >
              <CardContent className="px-6 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold tracking-tight text-foreground">
                        {job.title}
                      </h2>
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
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
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
                        {job.status === "active" ? (
                          <IconCircleCheck
                            size={12}
                            stroke={1.5}
                            className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400"
                          />
                        ) : (
                          <IconCircleOff
                            size={12}
                            stroke={1.5}
                            className="h-3 w-3 shrink-0 text-zinc-500 dark:text-zinc-400"
                          />
                        )}
                        {job.status === "active" ? "Active" : "Paused"}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {job.description}
                    </p>
                  </div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Job actions"
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
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                      >
                        {job.status === "active" ? (
                          <>
                            <IconPlayerPause size={14} stroke={1.5} />
                            Pause
                          </>
                        ) : (
                          <>
                            <IconPlayerPlay size={14} stroke={1.5} />
                            Start
                          </>
                        )}
                      </button>
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
