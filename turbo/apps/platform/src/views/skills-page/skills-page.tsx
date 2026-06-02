import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  ZeroAgentCustomSkill,
  ZeroAgentSkillContentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  IconDeviceFloppy,
  IconFileText,
  IconLoader2,
  IconSearch,
} from "@tabler/icons-react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { sortedAgents$ } from "../../signals/agent.ts";
import {
  filteredOrgSkills$,
  saveSelectedSkillContent$,
  selectedSkillDirty$,
  selectedSkillDraft$,
  selectedSkillAgentId$,
  selectedSkillDetail$,
  selectedSkillName$,
  setSelectedSkillAgentId$,
  setSelectedSkillDraft$,
  setSelectedSkillName$,
  setSkillSearch$,
  skillSearch$,
  skillUsages$,
} from "../../signals/skills-page/skills-signals.ts";
import { onDomEventFn } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";

const ALL_AGENTS_FILTER = "all";

function skillTitle(skill: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return skill.displayName ?? skill.name;
}

function agentTitle(agent: TeamComposeItem): string {
  return agent.displayName ?? agent.id;
}

export function SkillsPage() {
  const skillsLoadable = useLoadable(filteredOrgSkills$);
  const selectedSkillName = useLastResolved(selectedSkillName$);
  const skillUsages = useLastResolved(skillUsages$) ?? new Map();
  const skills =
    skillsLoadable.state === "hasData" ? skillsLoadable.data : null;
  const loading = skillsLoadable.state === "loading" && !skills;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-end justify-between gap-4">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Skills
            </h1>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto grid max-w-[1180px] gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <SkillsListPanel
            skills={skills}
            loading={loading}
            selectedSkillName={selectedSkillName}
            skillUsages={skillUsages}
          />
          <SkillDetailPanel />
        </div>
      </main>
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
    <section className="zero-card flex min-h-[420px] flex-col overflow-hidden">
      <SkillsToolbar />
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading ? (
          <SkillListSkeleton />
        ) : skills && skills.length > 0 ? (
          <div className="flex flex-col gap-1">
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
          <div className="flex min-h-[280px] flex-col items-center justify-center px-6 text-center">
            <IconFileText size={26} className="mb-3 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              No custom skills
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Skills created in Agent Chat will appear here.
            </p>
          </div>
        )}
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
    <div className="shrink-0 border-b border-border/70 p-3">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          placeholder="Search skills"
          className="h-9 pl-9"
        />
      </div>
      <div className="mt-2">
        <Select
          value={selectedAgentId ?? ALL_AGENTS_FILTER}
          onValueChange={(value) => {
            setSelectedAgentId(value === ALL_AGENTS_FILTER ? null : value);
          }}
        >
          <SelectTrigger aria-label="Agent filter" className="h-9 w-full">
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
  const usageLabel =
    agents.length === 1 ? "1 agent" : `${agents.length} agents`;

  return (
    <button
      type="button"
      className={`flex w-full flex-col rounded-lg px-3 py-2.5 text-left transition-colors ${
        selected
          ? "bg-gray-200 text-gray-900"
          : "text-foreground hover:bg-sidebar-accent"
      }`}
      onClick={() => {
        selectSkill(skill.name);
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <IconFileText size={15} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">
          {skillTitle(skill)}
        </span>
      </span>
      <span className="mt-1 truncate text-xs text-muted-foreground">
        {skill.description ?? skill.name}
      </span>
      <span className="mt-2 text-xs text-muted-foreground">{usageLabel}</span>
    </button>
  );
}

function SkillListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-1" data-testid="skills-loading">
      {[0, 1, 2, 3].map((index) => {
        return (
          <div key={index} className="rounded-lg px-3 py-2.5">
            <div className="h-4 w-40 rounded bg-muted" />
            <div className="mt-2 h-3 w-56 max-w-full rounded bg-muted" />
            <div className="mt-3 h-3 w-16 rounded bg-muted" />
          </div>
        );
      })}
    </div>
  );
}

function SkillDetailPanel() {
  const detailLoadable = useLoadable(selectedSkillDetail$);
  const selectedSkillName = useLastResolved(selectedSkillName$);
  const skillUsages = useLastResolved(skillUsages$) ?? new Map();
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const loading = detailLoadable.state === "loading" && !detail;

  if (loading) {
    return <SkillDetailSkeleton />;
  }

  if (!selectedSkillName || !detail) {
    return (
      <section className="zero-card flex min-h-[420px] items-center justify-center px-6 text-center">
        <div>
          <IconFileText
            size={28}
            className="mx-auto mb-3 text-muted-foreground"
          />
          <p className="text-sm font-medium text-foreground">Select a skill</p>
        </div>
      </section>
    );
  }

  return (
    <SkillEditor detail={detail} agents={skillUsages.get(detail.name) ?? []} />
  );
}

function SkillEditor({
  detail,
  agents,
}: {
  readonly detail: ZeroAgentSkillContentResponse;
  readonly agents: readonly TeamComposeItem[];
}) {
  const draft = useLastResolved(selectedSkillDraft$) ?? detail.content ?? "";
  const dirty = useLastResolved(selectedSkillDirty$) ?? false;
  const setDraft = useSet(setSelectedSkillDraft$);
  const pageSignal = useGet(pageSignal$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const [saveLoadable, saveSkill] = useLoadableSet(saveSelectedSkillContent$);
  const saving = saveLoadable.state === "loading";

  const canSave = isAdmin && dirty && !saving;
  const files = detail.files ?? [];
  const handleSave = onDomEventFn(async () => {
    if (!canSave) {
      return;
    }
    await saveSkill(draft, pageSignal);
  });
  const fileCountLabel =
    files.length === 1 ? "1 file" : `${files.length} files`;

  return (
    <section className="zero-card flex min-h-[560px] min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-4 border-b border-border/70 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <IconFileText
                size={18}
                className="shrink-0 text-muted-foreground"
              />
              <h2 className="truncate text-base font-semibold text-foreground">
                {skillTitle(detail)}
              </h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {detail.description ?? detail.name}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-2 rounded-lg border"
            disabled={!canSave}
            onClick={handleSave}
          >
            {saving ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconDeviceFloppy size={14} />
            )}
            Save
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="zero-badge rounded-md px-2 py-1">
            {fileCountLabel}
          </span>
          <span className="zero-badge rounded-md px-2 py-1">
            {agents.length === 1 ? "1 agent" : `${agents.length} agents`}
          </span>
        </div>

        <SkillAgents agents={agents} />
      </div>

      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="flex min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-4 text-xs font-medium text-muted-foreground">
            SKILL.md
          </div>
          <textarea
            aria-label="Skill instructions"
            value={draft}
            readOnly={!isAdmin}
            onChange={(event) => {
              setDraft(detail.name, event.target.value);
            }}
            className="min-h-[420px] flex-1 resize-none bg-background px-4 py-3 font-mono text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="SKILL.md"
            spellCheck={false}
          />
        </div>
        <SkillFiles files={files} />
      </div>
    </section>
  );
}

function SkillAgents({
  agents,
}: {
  readonly agents: readonly TeamComposeItem[];
}) {
  if (agents.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {agents.map((agent) => {
        return (
          <Link
            key={agent.id}
            pathname={ROUTES.agentDetail}
            options={{ pathParams: { agentId: agent.id } }}
            className="inline-flex h-7 max-w-full items-center rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <span className="truncate">{agentTitle(agent)}</span>
          </Link>
        );
      })}
    </div>
  );
}

function SkillFiles({
  files,
}: {
  readonly files: readonly { readonly path: string; readonly size: number }[];
}) {
  const totalSize = files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);

  return (
    <aside className="min-h-0 border-t border-border/70 bg-muted/20 lg:border-l lg:border-t-0">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <span className="text-xs font-medium text-muted-foreground">Files</span>
        <span className="text-xs text-muted-foreground">
          {formatBytes(totalSize)}
        </span>
      </div>
      <div className="max-h-[240px] overflow-auto p-2 lg:max-h-none">
        {files.map((file) => {
          return (
            <div
              key={file.path}
              className="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5"
            >
              <span className="min-w-0 truncate text-xs text-foreground">
                {file.path}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function SkillDetailSkeleton() {
  return (
    <section className="zero-card min-h-[560px] overflow-hidden">
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
