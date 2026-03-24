import { useState } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import {
  IconCrown,
  IconLoader2,
  IconPlus,
  IconUsers,
} from "@tabler/icons-react";
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
  createSubagent$,
} from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { zeroAvatarIndex$ } from "../../signals/zero-page/zero-nav.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { useAgentAvatar, AGENT_AVATARS } from "./zero-sidebar.tsx";
import zeroAvatarImg from "./assets/zero-avatar.webp";
import avatar1Img from "./assets/avatar-1.webp";
import avatar2Img from "./assets/avatar-2.webp";
import avatar3Img from "./assets/avatar-3.webp";
import avatar4Img from "./assets/avatar-4.webp";
import emptyChatImg from "./assets/empty-chat.webp";

const ZERO_AVATARS = [
  zeroAvatarImg,
  avatar1Img,
  avatar2Img,
  avatar3Img,
  avatar4Img,
] as const;

export function ZeroJobsPage() {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const rawNameLoadable = useLoadable(defaultAgentId$);
  const rawAgentName =
    rawNameLoadable.state === "hasData" ? rawNameLoadable.data : null;
  const agents = useLastResolved(zeroSubagents$);
  const loading = useGet(agentsLoading$);
  const error = useGet(agentsError$);
  const avatarIndex = useGet(zeroAvatarIndex$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const createSubagent = useSet(createSubagent$);

  const handleCreateTeammate = () => {
    const trimmed = newName.trim();
    if (!trimmed || creating) {
      return;
    }
    setCreating(true);
    detach(
      createSubagent(trimmed).then(
        () => {
          setDialogOpen(false);
          setNewName("");
          setCreating(false);
          toast.success(`${trimmed} created successfully`);
        },
        (error: unknown) => {
          setCreating(false);
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to create sub-agent",
          );
        },
      ),
      Reason.DomCallback,
    );
  };

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
                  loading="lazy"
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
              {/* Create teammate */}
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-[hsl(var(--gray-400))] transition-colors hover:border-[hsl(var(--gray-400))] hover:bg-muted/30 group cursor-pointer text-left"
              >
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors">
                    <IconPlus
                      size={18}
                      stroke={2}
                      className="text-foreground/50 group-hover:text-foreground transition-colors"
                    />
                  </span>
                  <span className="text-sm font-medium text-foreground/80 group-hover:text-foreground transition-colors">
                    Create teammate
                  </span>
                </div>
                <div className="border-t border-dashed border-[hsl(var(--gray-400))] px-4 py-2.5">
                  <span className="text-xs text-muted-foreground">
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
        </div>
      </main>

      <CreateTeammateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        newName={newName}
        onNameChange={setNewName}
        onConfirm={handleCreateTeammate}
        creating={creating}
      />
    </div>
  );
}

function CreateTeammateDialog({
  open,
  onOpenChange,
  newName,
  onNameChange,
  onConfirm,
  creating,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  creating: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={creating ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[480px] p-0 gap-0">
        <div className="flex flex-col items-center h-[min(360px,80dvh)]">
          <DialogHeader className="px-6 pt-8 pb-4 flex flex-col items-center text-center">
            <img
              src={AGENT_AVATARS[0]}
              alt="New teammate"
              className="h-16 w-16 rounded-full object-cover object-top mb-3"
            />
            <DialogTitle className="text-base font-semibold">
              Create a new teammate
            </DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Name your sub-agent to get started.
            </p>
          </DialogHeader>

          <div className="flex-1 flex items-center justify-center px-6">
            <Input
              value={newName}
              onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim() && !creating) {
                  onConfirm();
                }
              }}
              placeholder="e.g. Research Assistant"
              className="max-w-[280px] text-center"
              autoFocus
              disabled={creating}
            />
          </div>

          <div className="px-6 pb-6 pt-4 flex justify-end gap-2 w-full">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onConfirm}
              disabled={!newName.trim() || creating}
            >
              {creating ? (
                <span className="inline-flex items-center gap-1.5">
                  <IconLoader2 size={14} className="animate-spin" />
                  Creating...
                </span>
              ) : (
                "Create"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
