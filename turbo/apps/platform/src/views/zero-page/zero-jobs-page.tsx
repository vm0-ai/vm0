import { useGet, useLastResolved, useSet, useLoadable } from "ccstate-react";
import {
  IconCalendarCheck,
  IconCalendarOff,
  IconAlertTriangle,
  IconDotsVertical,
  IconMessageCircle,
  IconTrash,
} from "@tabler/icons-react";
import { Button, Card, CardContent } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  zeroSubagents$,
  schedules$,
  agentsMissingItems$,
  agentsLoading$,
  agentsError$,
  getAgentScheduleStatus,
} from "../../signals/zero-page/zero-agents.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { ZeroJobDetailPage } from "./zero-job-detail-page.tsx";

interface ZeroJobsPageProps {
  onNavigateToChat?: () => void;
  selectedAgentName?: string | null;
}

export function ZeroJobsPage({
  onNavigateToChat,
  selectedAgentName,
}: ZeroJobsPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const agents = useLastResolved(zeroSubagents$);
  const schedulesList = useGet(schedules$);
  const missingItems = useLastResolved(agentsMissingItems$);
  const loading = useGet(agentsLoading$);
  const error = useGet(agentsError$);
  const navigate = useSet(navigateInReact$);

  const missingMap = new Map(missingItems?.map((a) => [a.agentName, a]));

  if (selectedAgentName) {
    return <ZeroJobDetailPage agentName={selectedAgentName} />;
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
          {onNavigateToChat && (
            <Button
              className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border px-4"
              onClick={onNavigateToChat}
            >
              <IconMessageCircle size={14} stroke={1.5} />
              Create sub agent
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          {loading && (!agents || agents.length === 0) && (
            <>
              {[1, 2, 3].map((i) => (
                <Card key={i} className="zero-card">
                  <CardContent className="px-6 py-4">
                    <div className="flex items-center gap-4 animate-pulse">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="h-4 w-40 rounded bg-muted" />
                        <div className="h-3 w-64 rounded bg-muted" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </>
          )}

          {error && (
            <Card className="zero-card">
              <CardContent className="px-6 py-6 text-center space-y-3">
                <p className="text-sm text-destructive">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="zero-btn-morandi"
                  onClick={() => navigate("/zero")}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}

          {!loading && !error && agents && agents.length === 0 && (
            <Card className="zero-card">
              <CardContent className="px-6 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No sub-agents yet. Create one by chatting with Zero.
                </p>
              </CardContent>
            </Card>
          )}

          {agents?.map((agent) => {
            const hasSchedule = getAgentScheduleStatus(
              agent.name,
              schedulesList,
            );
            const missing = missingMap.get(agent.name);
            const missingCount =
              (missing?.missingSecrets.length ?? 0) +
              (missing?.missingVariables.length ?? 0);

            return (
              <Card
                key={agent.name}
                role="button"
                tabIndex={0}
                className="zero-card cursor-pointer hover:border-border transition-colors"
                onClick={() =>
                  navigate("/zero/team/:name", {
                    pathParams: { name: agent.name },
                  })
                }
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  navigate("/zero/team/:name", {
                    pathParams: { name: agent.name },
                  })
                }
              >
                <CardContent className="px-6 py-4">
                  <div className="flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-semibold tracking-tight text-foreground">
                          {agent.displayName ?? agent.name}
                        </h2>
                        <span className="zero-pill inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs font-medium">
                          {hasSchedule ? (
                            <IconCalendarCheck
                              size={12}
                              stroke={1.5}
                              className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400"
                            />
                          ) : (
                            <IconCalendarOff
                              size={12}
                              stroke={1.5}
                              className="h-3 w-3 shrink-0 text-muted-foreground"
                            />
                          )}
                          {hasSchedule ? "Scheduled" : "No schedule"}
                        </span>
                        {missingCount > 0 && (
                          <span className="zero-pill inline-flex items-center gap-1.5 rounded-md border border-amber-300 dark:border-amber-700 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                            <IconAlertTriangle
                              size={12}
                              stroke={1.5}
                              className="h-3 w-3 shrink-0"
                            />
                            {missingCount} missing
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Last edited{" "}
                        {new Date(agent.updatedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
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
            );
          })}
        </div>
      </main>
    </div>
  );
}
