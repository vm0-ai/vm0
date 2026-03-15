import { useGet, useLastResolved, useSet, useLoadable } from "ccstate-react";
import {
  IconSparkles,
  IconMessageCircle,
  IconUsers,
} from "@tabler/icons-react";
import { Button, Card, CardContent } from "@vm0/ui";
import {
  zeroSubagents$,
  agentsLoading$,
  agentsError$,
} from "../../signals/zero-page/zero-agents.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { ZeroJobDetailPage } from "./zero-job-detail-page.tsx";
import { getAgentAvatar } from "./zero-sidebar.tsx";

interface ZeroJobsPageProps {
  onNavigateToChat?: () => void;
  selectedAgentName?: string | null;
  zeroAvatarSrc?: string;
}

export function ZeroJobsPage({
  onNavigateToChat,
  selectedAgentName,
  zeroAvatarSrc = "/zero-avatar.png",
}: ZeroJobsPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const agents = useLastResolved(zeroSubagents$);
  const loading = useGet(agentsLoading$);
  const error = useGet(agentsError$);
  const navigate = useSet(navigateInReact$);

  if (selectedAgentName) {
    return <ZeroJobDetailPage agentName={selectedAgentName} />;
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
            onClick={() =>
              navigate("/zero/:tab", { pathParams: { tab: "meet" } })
            }
            onKeyDown={(e) =>
              e.key === "Enter" &&
              navigate("/zero/:tab", { pathParams: { tab: "meet" } })
            }
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

          {/* Sub-agents grid */}
          {loading && (!agents || agents.length === 0) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="zero-card">
                  <CardContent className="p-5">
                    <div className="flex items-center gap-3 animate-pulse">
                      <div className="h-10 w-10 rounded-full bg-muted" />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="h-4 w-24 rounded bg-muted" />
                        <div className="h-3 w-16 rounded bg-muted" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
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
              <CardContent className="flex flex-col items-center justify-center px-6 py-12 gap-3">
                <img
                  src="/images/empty-chat.png"
                  alt="No teammates"
                  className="h-20 w-20 object-contain opacity-80"
                />
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground">
                    No teammates yet
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Start a chat with {agentName} to create one.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {agents && agents.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* Create teammate — col-span-full */}
              <button
                type="button"
                className="flex items-center gap-3 rounded-[var(--zero-card-radius)] border border-dashed border-foreground/20 px-4 py-3.5 transition-colors hover:border-foreground/30 hover:bg-muted/30 group col-span-full"
                onClick={onNavigateToChat}
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

              {agents.map((agent) => {
                const displayName = agent.displayName ?? agent.name;
                return (
                  <Card
                    key={agent.name}
                    role="button"
                    tabIndex={0}
                    className="zero-card cursor-pointer flex flex-col"
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
                    <CardContent className="p-5 flex flex-col flex-1 gap-3">
                      <span className="self-start inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground">
                        <IconUsers
                          size={12}
                          stroke={1.5}
                          className="h-3 w-3 shrink-0 text-sky-600 dark:text-sky-400"
                        />
                        Workspace
                      </span>
                      <div className="flex items-center gap-2.5">
                        <img
                          src={getAgentAvatar(agent.name)}
                          alt={displayName}
                          className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
                        />
                        <h2 className="text-base font-semibold tracking-tight text-foreground truncate">
                          {displayName}
                        </h2>
                      </div>
                      {agent.description && (
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {agent.description}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
