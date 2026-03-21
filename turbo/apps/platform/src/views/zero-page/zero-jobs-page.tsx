/* eslint-disable ccstate/no-use-ccstate-in-views */
import { useCCState } from "ccstate-react/experimental";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { IconCrown, IconPlus, IconUsers } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from "@vm0/ui";
import {
  zeroSubagents$,
  agentsLoading$,
  agentsError$,
} from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentName$,
} from "../../signals/zero-page/zero-agent-name.ts";
import {
  sendZeroChatMessage$,
  startNewZeroSession$,
} from "../../signals/zero-page/zero-chat.ts";
import { updatePathname$ } from "../../signals/route.ts";
import { Link } from "../router/link.tsx";
import { ZeroJobDetailPage } from "./zero-job-detail-page.tsx";
import { useAgentAvatar, AGENT_AVATARS } from "./zero-sidebar.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import zeroAvatarImg from "./assets/zero-avatar.png";
import emptyChatImg from "./assets/empty-chat.png";

interface ZeroJobsPageProps {
  selectedAgentName?: string | null;
  zeroAvatarSrc?: string;
  onCycleZeroAvatar?: () => void;
}

export function ZeroJobsPage({
  selectedAgentName,
  zeroAvatarSrc = zeroAvatarImg,
  onCycleZeroAvatar,
}: ZeroJobsPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const rawNameLoadable = useLoadable(defaultAgentName$);
  const rawAgentName =
    rawNameLoadable.state === "hasData" ? rawNameLoadable.data : null;
  const agents = useLastResolved(zeroSubagents$);
  const loading = useGet(agentsLoading$);
  const error = useGet(agentsError$);

  const createDialogOpen$ = useCCState(false);
  const createDialogOpen = useGet(createDialogOpen$);
  const setCreateDialogOpen = useSet(createDialogOpen$);
  const newName$ = useCCState("");
  const newName = useGet(newName$);
  const setNewName = useSet(newName$);

  const navigate = useSet(updatePathname$);
  const startNewSession = useSet(startNewZeroSession$);
  const sendMessage = useSet(sendZeroChatMessage$);

  const handleCreateTeammate = () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      return;
    }
    setCreateDialogOpen(false);
    navigate("/");
    startNewSession();
    detach(
      sendMessage(`Create a new sub-agent called "${trimmed}"`),
      Reason.DomCallback,
    );
    setNewName("");
  };

  const isDefaultAgent = selectedAgentName === rawAgentName;

  if (selectedAgentName) {
    return (
      <ZeroJobDetailPage
        agentName={selectedAgentName}
        zeroAvatarSrc={isDefaultAgent ? zeroAvatarSrc : undefined}
        onCycleAvatar={isDefaultAgent ? onCycleZeroAvatar : undefined}
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
          {rawAgentName ? (
            <Link
              pathname="/team/:name"
              options={{ pathParams: { name: rawAgentName } }}
              className="block no-underline text-inherit"
            >
              <Card className="zero-card cursor-pointer hover:bg-muted/30 transition-colors">
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
                      <span className="zero-pill inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-xs font-medium">
                        <IconCrown
                          size={12}
                          stroke={1.8}
                          className="shrink-0 text-amber-500 dark:text-amber-400"
                        />
                        Lead
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Your primary AI assistant that manages your team and
                      orchestrates workflows.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ) : (
            <Card className="zero-card">
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
                    <span className="zero-pill inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-xs font-medium">
                      <IconCrown
                        size={12}
                        stroke={1.8}
                        className="shrink-0 text-amber-500 dark:text-amber-400"
                      />
                      Lead
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Your primary AI assistant that manages your team and
                    orchestrates workflows.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

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
                <Link
                  pathname="/"
                  className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
                >
                  Retry
                </Link>
              </CardContent>
            </Card>
          )}

          {!loading && !error && agents && agents.length === 0 && (
            <Card className="zero-card">
              <CardContent className="flex flex-col items-center justify-center px-6 py-12 gap-3">
                <img
                  src={emptyChatImg}
                  alt="No teammates"
                  className="h-20 w-20 object-contain opacity-80"
                />
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground">
                    Just {agentName} for now
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Ask {agentName} to create a teammate and they&apos;ll show
                    up here.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {agents && agents.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setCreateDialogOpen(true)}
                className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-[hsl(var(--gray-400))] transition-colors hover:border-[hsl(var(--gray-400))] hover:bg-muted/30 group text-left"
              >
                <div className="flex h-14 items-center gap-2.5 px-5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    <IconPlus
                      size={18}
                      stroke={2}
                      className="text-muted-foreground group-hover:text-foreground"
                    />
                  </span>
                  <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground">
                    Create teammate
                  </span>
                </div>
                <div className="flex h-11 items-center border-t border-dashed border-[hsl(var(--gray-400))] px-5 group-hover:border-[hsl(var(--gray-400))]">
                  <span className="text-xs text-muted-foreground/70">
                    Chat with {agentName} to create a sub-agent
                  </span>
                </div>
              </button>

              {agents.map((agent) => (
                <Link
                  key={agent.name}
                  pathname="/team/:name"
                  options={{ pathParams: { name: agent.name } }}
                  className="block no-underline text-inherit"
                >
                  <AgentCard agent={agent} />
                </Link>
              ))}
            </div>
          )}

          <CreateTeammateDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
            name={newName}
            onNameChange={setNewName}
            onConfirm={handleCreateTeammate}
          />
        </div>
      </main>
    </div>
  );
}

function AgentCard({
  agent,
}: {
  agent: {
    name: string;
    displayName?: string | null;
    description?: string | null;
  };
}) {
  const avatarSrc = useAgentAvatar(agent.name);
  const displayName = agent.displayName ?? agent.name;
  return (
    <Card className="zero-card cursor-pointer flex flex-col hover:bg-muted/30 transition-colors h-full">
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
            src={avatarSrc}
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
}

function CreateTeammateDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
}) {
  const avatarSrc = AGENT_AVATARS[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="zero-app sm:max-w-[480px] h-[min(360px,80dvh)] gap-0 p-0 flex flex-col rounded-xl border border-border bg-card shadow-lg"
        aria-describedby={undefined}
      >
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center text-center px-8 py-8">
          <DialogHeader className="sr-only">
            <DialogTitle>Create teammate</DialogTitle>
          </DialogHeader>
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl mb-5">
            <img
              src={avatarSrc}
              alt=""
              role="presentation"
              className="h-16 w-16 rounded-full object-cover object-top"
            />
          </div>
          <h2 className="text-xl font-semibold tracking-tight mb-2">
            Create a new teammate
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-[320px] mb-6">
            Name your sub-agent to get started.
          </p>
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onConfirm();
              }
            }}
            placeholder="Teammate name"
            className="max-w-[280px] text-center text-base border-[0.7px] border-[hsl(var(--gray-400))] focus:border-primary focus:ring-[3px] focus:ring-primary/10"
            autoFocus
          />
        </div>
        <div
          className="shrink-0 h-16 flex items-center justify-end gap-2 px-8"
          style={{ borderTop: "0.7px solid hsl(var(--gray-400))" }}
        >
          <Button
            variant="ghost"
            className="rounded-lg text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            className="rounded-lg min-w-[100px]"
            disabled={!name.trim()}
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
