// Slash-skill domain helpers and the suggestion menu, shared by the chat
// composer. Kept in its own module so the textarea composer and the TipTap
// skill composer can both reuse them without an import cycle.
import { useSet } from "ccstate-react";
import { IconChevronRight, IconFileText } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import type { ZeroAgentCustomSkill } from "@vm0/api-contracts/contracts/zero-agents";
import { setSlashSkillMenuRef$ } from "../../signals/zero-page/zero-chat-composer.ts";
import { Link } from "../router/link.tsx";

export interface SlashSkillRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerSlashSkill extends ZeroAgentCustomSkill {
  readonly token: string;
}

export function findActiveSlashSkillRange(
  value: string,
  caretIndex: number,
): SlashSkillRange | null {
  const beforeCaret = value.slice(0, caretIndex);
  const match = /(?:^|\s)\/([a-z0-9-]*)$/i.exec(beforeCaret);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const slashOffset = match[0].lastIndexOf("/");
  const start = beforeCaret.length - match[0].length + slashOffset;
  return { start, end: caretIndex, query };
}

export function matchesSkillQuery(
  skill: ComposerSlashSkill,
  query: string,
): boolean {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  return [skill.name, skill.displayName ?? "", skill.description ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(normalizedQuery);
}

export function skillTokenPattern(
  skillNames: readonly string[],
): RegExp | null {
  if (skillNames.length === 0) {
    return null;
  }

  const escaped = skillNames.map((name) => {
    return name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  });
  return new RegExp(`/(?:${escaped.join("|")})(?=$|\\s)`, "g");
}

export function buildComposerSlashSkills({
  agentSkillNames,
  orgSkills,
}: {
  readonly agentSkillNames: readonly string[];
  readonly orgSkills: readonly ZeroAgentCustomSkill[];
}): readonly ComposerSlashSkill[] {
  const metadataByName = new Map(
    orgSkills.map((skill) => {
      return [skill.name, skill];
    }),
  );
  return agentSkillNames.map((name) => {
    const metadata = metadataByName.get(name);
    return {
      name,
      displayName: metadata?.displayName ?? null,
      description: metadata?.description ?? null,
      token: `/${name}`,
    };
  });
}

function slashSkillOptionId(skillName: string): string {
  return `slash-skill-option-${skillName}`;
}

export function scrollSlashSkillIntoView(
  skill: ComposerSlashSkill | undefined,
): void {
  if (!skill) {
    return;
  }

  window.requestAnimationFrame(() => {
    const option = document.getElementById(slashSkillOptionId(skill.name));
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

export function SlashSkillMenu({
  skills,
  loading,
  selectedIndex,
  showSkillsPageLink,
  onSelect,
}: {
  readonly skills: readonly ComposerSlashSkill[];
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly showSkillsPageLink: boolean;
  readonly onSelect: (skill: ComposerSlashSkill) => void;
}) {
  const setMenuRef = useSet(setSlashSkillMenuRef$);

  return (
    <div
      ref={setMenuRef}
      popover="manual"
      className="slash-skill-popover flex max-h-80 w-[260px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-md border border-border/70 bg-popover/95 text-popover-foreground shadow-lg backdrop-blur"
      data-testid="slash-skill-menu"
    >
      <div className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
        Skills
      </div>
      {loading ? (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">
          Loading skills...
        </div>
      ) : skills.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {skills.map((skill, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                id={slashSkillOptionId(skill.name)}
                key={skill.name}
                type="button"
                className={cn(
                  "flex w-full items-center rounded px-2 py-1.5 text-left transition-colors",
                  selected ? "bg-accent" : "hover:bg-accent/60",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(skill);
                }}
              >
                <span className="truncate font-mono text-sm text-primary">
                  {skill.token}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-2.5 pt-1 pb-2.5 text-sm text-muted-foreground">
          No matching skills
        </div>
      )}
      {showSkillsPageLink && (
        <div className="shrink-0 border-t border-border/60 bg-popover/95 p-1.5">
          <Link
            pathname="/skills"
            className="flex h-9 w-full items-center justify-between rounded px-2 text-sm font-medium text-popover-foreground transition-colors hover:bg-accent"
          >
            <span className="flex min-w-0 items-center gap-2">
              <IconFileText
                size={16}
                stroke={1.8}
                className="shrink-0 text-muted-foreground"
              />
              <span className="truncate">View all skills</span>
            </span>
            <IconChevronRight
              size={16}
              stroke={1.8}
              className="shrink-0 text-muted-foreground"
            />
          </Link>
        </div>
      )}
    </div>
  );
}
