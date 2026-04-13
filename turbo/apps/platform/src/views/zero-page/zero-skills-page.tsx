import { useGet, useSet, useLastLoadable, useLoadable } from "ccstate-react";
import {
  IconPlus,
  IconDotsVertical,
  IconSparkles,
  IconLock,
} from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";
import { skillsList$ } from "../../signals/skills-page/skills-list.ts";
import {
  openCreateEditor$,
  openEditEditor$,
} from "../../signals/skills-page/skill-editor.ts";
import {
  pendingDeleteName$,
  setPendingDeleteName$,
} from "../../signals/skills-page/skill-delete.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ZeroSkillEditor } from "./zero-skill-editor.tsx";
import { ZeroSkillDeleteConfirm } from "./zero-skill-delete-confirm.tsx";

export function ZeroSkillsPage() {
  const skillsLoadable = useLastLoadable(skillsList$);
  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;
  const openCreate = useSet(openCreateEditor$);
  const openEdit = useSet(openEditEditor$);
  const setPendingDelete = useSet(setPendingDeleteName$);
  const pendingDelete = useGet(pendingDeleteName$);
  const signal = useGet(pageSignal$);

  const skills = skillsLoadable.state === "hasData" ? skillsLoadable.data : [];

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-center justify-between gap-4">
            <div className="hidden md:block">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Custom Skills
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Reusable instructions agents can opt into. Create and edit the
                SKILL.md here; manage attached files via the CLI.
              </p>
            </div>
            {isAdmin && (
              <Button
                size="sm"
                onClick={() => {
                  openCreate();
                }}
              >
                <IconPlus size={14} stroke={1.5} className="mr-1" />
                New skill
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 pt-3 pb-16">
        <div className="mx-auto max-w-[900px] flex flex-col gap-3">
          {skillsLoadable.state === "loading" && (
            <div className="space-y-2 animate-pulse">
              <div className="h-14 w-full rounded-md bg-muted/30" />
              <div className="h-14 w-full rounded-md bg-muted/30" />
              <div className="h-14 w-full rounded-md bg-muted/30" />
            </div>
          )}

          {skillsLoadable.state === "hasError" && (
            <p className="py-12 text-center text-sm text-destructive">
              Failed to load skills.
            </p>
          )}

          {skillsLoadable.state === "hasData" && skills.length === 0 && (
            <div className="py-12 text-center">
              <IconSparkles
                size={28}
                stroke={1.5}
                className="mx-auto text-muted-foreground/60"
              />
              <p className="text-sm text-muted-foreground mt-3">
                No custom skills yet.
              </p>
              {isAdmin ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    openCreate();
                  }}
                >
                  <IconPlus size={14} stroke={1.5} className="mr-1" />
                  Create your first skill
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground mt-2">
                  Ask an org admin to create one.
                </p>
              )}
            </div>
          )}

          {skillsLoadable.state === "hasData" &&
            skills.length > 0 &&
            skills.map((skill) => {
              return (
                <SkillRow
                  key={skill.name}
                  name={skill.name}
                  displayName={skill.displayName}
                  description={skill.description}
                  isAdmin={isAdmin}
                  onEdit={() => {
                    detach(
                      openEdit(skill.name, signal),
                      Reason.DomCallback,
                      "open-skill-editor",
                    );
                  }}
                  onDelete={() => {
                    setPendingDelete(skill.name);
                  }}
                />
              );
            })}
        </div>
      </main>

      <ZeroSkillEditor />
      {pendingDelete !== null && (
        <ZeroSkillDeleteConfirm
          name={pendingDelete}
          onClose={() => {
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}

function SkillRow({
  name,
  displayName,
  description,
  isAdmin,
  onEdit,
  onDelete,
}: {
  name: string;
  displayName: string | null;
  description: string | null;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-card px-4 py-3">
      <button
        type="button"
        className="flex-1 min-w-0 text-left"
        onClick={() => {
          if (isAdmin) {
            onEdit();
          }
        }}
        disabled={!isAdmin}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {displayName ?? name}
          </span>
          <span className="text-xs text-muted-foreground truncate">{name}</span>
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {description}
          </p>
        )}
      </button>
      {isAdmin ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label={`Actions for ${name}`}
            >
              <IconDotsVertical size={14} stroke={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground/60"
          aria-label="Read-only"
        >
          <IconLock size={14} stroke={1.5} />
        </span>
      )}
    </div>
  );
}
