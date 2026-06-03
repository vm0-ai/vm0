import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import type {
  ZeroAgentCustomSkill,
  ZeroAgentSkillDetailResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { IconChevronRight, IconSearch, IconUsers } from "@tabler/icons-react";
import {
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

import { sortedAgents$ } from "../../signals/agent.ts";
import {
  filteredOrgSkills$,
  selectedSkillAgentId$,
  selectedSkillDetail$,
  selectedSkillFilePath$,
  selectedSkillName$,
  setSelectedSkillAgentId$,
  setSelectedSkillFilePath$,
  setSelectedSkillName$,
  setSkillSearch$,
  skillSearch$,
  skillUsages$,
} from "../../signals/skills-page/skills-signals.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Markdown } from "../components/markdown.tsx";
import { Link } from "../router/link.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";

const ALL_AGENTS_FILTER = "all";
const LIST_AVATAR_LIMIT = 5;
const SKILL_LIST_GRID =
  "grid grid-cols-[minmax(10rem,1.1fr)_minmax(16rem,1.8fr)_8rem_2.5rem] gap-x-6 items-center";
const LEADING_YAML_FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function skillTitle(skill: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return skill.displayName ?? skill.name;
}

function agentTitle(agent: TeamComposeItem): string {
  return agent.displayName ?? agent.id;
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function stripMarkdownFrontmatter(content: string): string {
  return content.replace(LEADING_YAML_FRONTMATTER_PATTERN, "");
}

export function SkillsPage() {
  const skillsLoadable = useLoadable(filteredOrgSkills$);
  const selectedSkillName = useGet(selectedSkillName$);
  const skillUsages = useLastResolved(skillUsages$) ?? new Map();
  const skills =
    skillsLoadable.state === "hasData" ? skillsLoadable.data : null;
  const loading = skillsLoadable.state === "loading" && !skills;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
            <div className="hidden min-w-0 md:block">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                Skills
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Browse shared skills and see which agents use them.
              </p>
            </div>
            <SkillsToolbar />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <SkillsListPanel
            skills={skills}
            loading={loading}
            selectedSkillName={selectedSkillName}
            skillUsages={skillUsages}
          />
        </div>
      </main>
      <SkillDetailDialog
        open={selectedSkillName !== null}
        agents={
          selectedSkillName ? (skillUsages.get(selectedSkillName) ?? []) : []
        }
      />
    </div>
  );
}

function SkillsListPanel({
  skills,
  loading,
  selectedSkillName,
  skillUsages,
}: {
  readonly skills: readonly ZeroAgentCustomSkill[] | null;
  readonly loading: boolean;
  readonly selectedSkillName: string | null | undefined;
  readonly skillUsages: ReadonlyMap<string, readonly TeamComposeItem[]>;
}) {
  return (
    <section className="zero-card min-h-[520px] overflow-hidden pb-3">
      <div className="overflow-x-auto">
        <div style={{ minWidth: "820px" }}>
          {(loading || (skills && skills.length > 0)) && (
            <div
              className={cn(
                SKILL_LIST_GRID,
                "sticky top-0 z-10 border-b border-border/40 bg-card px-5 py-3 text-sm font-medium text-muted-foreground",
              )}
            >
              <div className="text-left">Skill</div>
              <div className="text-left">Description</div>
              <div className="text-left">Used by</div>
              <div />
            </div>
          )}
          {loading ? (
            <SkillListSkeleton />
          ) : skills && skills.length > 0 ? (
            <div>
              {skills.map((skill) => {
                return (
                  <SkillListItem
                    key={skill.name}
                    skill={skill}
                    selected={skill.name === selectedSkillName}
                    agents={skillUsages.get(skill.name) ?? []}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[20rem] flex-col items-center justify-center px-6 text-center">
              <p className="text-sm font-medium text-foreground">
                No custom skills
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Skills created in Agent Chat will appear here.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SkillsToolbar() {
  const search = useGet(skillSearch$);
  const selectedAgentId = useGet(selectedSkillAgentId$);
  const setSearch = useSet(setSkillSearch$);
  const setSelectedAgentId = useSet(setSelectedSkillAgentId$);
  const agentsLoadable = useLoadable(sortedAgents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const agentOptions = agents.filter((agent) => {
    return (agent.customSkills ?? []).length > 0;
  });

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
      <div className="sm:w-48">
        <Select
          value={selectedAgentId ?? ALL_AGENTS_FILTER}
          onValueChange={(value) => {
            setSelectedAgentId(value === ALL_AGENTS_FILTER ? null : value);
          }}
        >
          <SelectTrigger
            aria-label="Agent filter"
            className="zero-btn-morandi h-9 w-full gap-1.5 rounded-lg px-3.5 text-sm font-medium"
          >
            <IconUsers size={14} stroke={1.5} className="shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AGENTS_FILTER}>All agents</SelectItem>
            {agentOptions.map((agent) => {
              return (
                <SelectItem key={agent.id} value={agent.id}>
                  {agentTitle(agent)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <div className="relative w-full sm:w-64">
        <IconSearch
          size={15}
          stroke={1.5}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
        />
        <input
          aria-label="Search skills"
          type="text"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          placeholder="Search skills"
          className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10"
        />
      </div>
    </div>
  );
}

function SkillListItem({
  skill,
  selected,
  agents,
}: {
  readonly skill: ZeroAgentCustomSkill;
  readonly selected: boolean;
  readonly agents: readonly TeamComposeItem[];
}) {
  const selectSkill = useSet(setSelectedSkillName$);

  return (
    <button
      type="button"
      className={cn(
        "block w-full cursor-pointer border-b border-border/40 px-5 py-3 text-left text-inherit transition-colors last:border-b-0",
        selected
          ? "bg-muted/60 text-foreground"
          : "text-foreground hover:bg-muted/50",
      )}
      onClick={() => {
        selectSkill(skill.name);
      }}
    >
      <div className={cn(SKILL_LIST_GRID)}>
        <div className="min-w-0 text-left">
          <span className="block truncate text-sm font-medium text-foreground">
            {skillTitle(skill)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {skill.name}
          </span>
        </div>
        <span className="line-clamp-2 min-w-0 text-left text-sm leading-5 text-muted-foreground">
          {skill.description ?? skill.name}
        </span>
        <AgentAvatarStack agents={agents} />
        <span className="justify-self-start rounded p-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground">
          <IconChevronRight size={14} stroke={1.5} />
        </span>
      </div>
    </button>
  );
}

function SkillListSkeleton() {
  return (
    <div className="divide-y divide-border/40" data-testid="skills-loading">
      {[0, 1, 2, 3].map((index) => {
        return (
          <div key={index} className={cn(SKILL_LIST_GRID, "px-5 py-3")}>
            <div className="h-9 w-44 rounded bg-muted/50" />
            <div className="h-4 w-full rounded bg-muted/50" />
            <div className="h-7 w-20 rounded-full bg-muted/50" />
            <div className="h-4 w-4 rounded bg-muted/50" />
          </div>
        );
      })}
    </div>
  );
}

function SkillDetailDialog({
  open,
  agents,
}: {
  readonly open: boolean;
  readonly agents: readonly TeamComposeItem[];
}) {
  const setSelectedSkillName = useSet(setSelectedSkillName$);
  const detailLoadable = useLoadable(selectedSkillDetail$);
  const selectedSkillName = useLastResolved(selectedSkillName$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const loading = detailLoadable.state === "loading" && !detail;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSelectedSkillName(null);
        }
      }}
    >
      <DialogContent
        aria-describedby="skill-detail-dialog-description"
        className="max-w-[940px] gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Skill details</DialogTitle>
        <DialogDescription
          id="skill-detail-dialog-description"
          className="sr-only"
        >
          View skill content, usage, and files.
        </DialogDescription>
        {loading || !selectedSkillName || !detail ? (
          <SkillDetailSkeleton />
        ) : (
          <SkillEditor detail={detail} agents={agents} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SkillEditor({
  detail,
  agents,
}: {
  readonly detail: ZeroAgentSkillDetailResponse;
  readonly agents: readonly TeamComposeItem[];
}) {
  const explicitSelectedFilePath = useGet(selectedSkillFilePath$);
  const setSelectedFilePath = useSet(setSelectedSkillFilePath$);
  const files = detail.files ?? [];
  const preferredFilePath =
    files.find((file) => {
      return file.path === "SKILL.md";
    })?.path ??
    files[0]?.path ??
    (detail.content !== null ? "SKILL.md" : null);
  const selectedFilePath = explicitSelectedFilePath ?? preferredFilePath;
  const selectedFile = selectedFilePath
    ? (detail.fileContents ?? []).find((file) => {
        return file.path === selectedFilePath;
      })
    : null;
  const selectedContent = selectedFilePath
    ? (selectedFile?.content ??
      (selectedFilePath === "SKILL.md" ? detail.content : null))
    : null;

  return (
    <div className="flex max-h-[88vh] min-w-0 flex-col overflow-hidden">
      <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4 pr-14">
        <h2 className="truncate text-base font-semibold leading-none tracking-tight">
          {skillTitle(detail)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {detail.description ?? detail.name}
        </p>
      </DialogHeader>

      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-4 text-xs font-medium text-muted-foreground">
            <span className="truncate">
              {selectedFilePath ?? "No file selected"}
            </span>
          </div>
          {selectedFilePath && selectedContent !== null ? (
            isMarkdownPath(selectedFilePath) ? (
              <div
                aria-label="Skill content"
                className="min-h-[420px] flex-1 overflow-auto bg-background px-4 py-3"
              >
                <Markdown source={stripMarkdownFrontmatter(selectedContent)} />
              </div>
            ) : (
              <pre
                aria-label="Skill content"
                className="min-h-[420px] flex-1 overflow-auto whitespace-pre-wrap bg-background px-4 py-3 font-mono text-sm leading-6 text-foreground"
              >
                {selectedContent}
              </pre>
            )
          ) : (
            <div className="flex min-h-[420px] flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
              {selectedFilePath
                ? "No content available for this file."
                : "No files."}
            </div>
          )}
        </div>
        <aside className="min-h-0 border-t border-border/70 bg-muted/20 lg:border-l lg:border-t-0">
          <BoundAgentsPanel agents={agents} />
          <SkillFiles
            files={files}
            selectedPath={selectedFilePath}
            onSelectFile={setSelectedFilePath}
          />
        </aside>
      </div>
    </div>
  );
}

function BoundAgentsPanel({
  agents,
}: {
  readonly agents: readonly TeamComposeItem[];
}) {
  return (
    <div className="border-b border-border/70">
      <div className="flex h-9 items-center justify-between px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Used by
        </span>
        <span className="text-xs text-muted-foreground">{agents.length}</span>
      </div>
      <div className="max-h-[180px] overflow-auto px-2 pb-2">
        {agents.length > 0 ? (
          <div className="flex flex-col gap-1">
            {agents.map((agent) => {
              return (
                <Link
                  key={agent.id}
                  pathname={ROUTES.agentDetail}
                  options={{ pathParams: { agentId: agent.id } }}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <AgentAvatar agent={agent} />
                  <span className="truncate">{agentTitle(agent)}</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="px-2 pb-3 text-xs text-muted-foreground">
            No agents use this skill.
          </p>
        )}
      </div>
    </div>
  );
}

function AgentAvatar({ agent }: { readonly agent: TeamComposeItem }) {
  const title = agentTitle(agent);
  if (agent.avatarUrl) {
    return (
      <AvatarFromUrl
        avatarUrl={agent.avatarUrl}
        alt={title}
        size={24}
        className="size-6 shrink-0 rounded-full object-cover"
      />
    );
  }

  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-[10px] text-muted-foreground">
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}

function AgentAvatarStack({
  agents,
}: {
  readonly agents: readonly TeamComposeItem[];
}) {
  if (agents.length === 0) {
    return (
      <span className="text-xs text-muted-foreground" aria-label="No agents">
        None
      </span>
    );
  }

  const visibleAgents = agents.slice(0, LIST_AVATAR_LIMIT);
  const overflow = agents.length - visibleAgents.length;

  return (
    <span
      className="flex min-w-0 items-center"
      aria-label={`${agents.length} ${agents.length === 1 ? "agent" : "agents"} use this skill`}
    >
      {visibleAgents.map((agent, index) => {
        return (
          <span
            key={agent.id}
            className={`rounded-full ring-2 ring-background ${
              index === 0 ? "" : "-ml-2"
            }`}
          >
            <AgentAvatar agent={agent} />
          </span>
        );
      })}
      {overflow > 0 ? (
        <span
          className="-ml-2 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background"
          aria-label={`${overflow} more ${overflow === 1 ? "agent" : "agents"}`}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

function SkillFiles({
  files,
  selectedPath,
  onSelectFile,
}: {
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  return (
    <div className="min-h-0">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <span className="text-xs font-medium text-muted-foreground">Files</span>
        <span className="text-xs text-muted-foreground">{files.length}</span>
      </div>
      <div className="max-h-[240px] overflow-auto p-2 lg:max-h-none">
        {files.length > 0 ? (
          <div className="flex flex-col gap-1">
            {files.map((file) => {
              const selected = file.path === selectedPath;
              return (
                <button
                  key={file.path}
                  type="button"
                  aria-pressed={selected}
                  className={`flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors ${
                    selected
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/70"
                  }`}
                  onClick={() => {
                    onSelectFile(file.path);
                  }}
                >
                  <span className="min-w-0 truncate text-xs">{file.path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(file.size)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-2 pb-3 text-xs text-muted-foreground">No files.</p>
        )}
      </div>
    </div>
  );
}

function SkillDetailSkeleton() {
  return (
    <section className="min-h-[560px] overflow-hidden">
      <div className="border-b border-border/70 p-4">
        <div className="h-5 w-56 rounded bg-muted" />
        <div className="mt-3 h-4 w-72 max-w-full rounded bg-muted" />
      </div>
      <div className="p-4">
        <div className="h-[420px] rounded bg-muted" />
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}
