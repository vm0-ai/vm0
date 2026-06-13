// Slash-skill domain helpers and the suggestion menu, shared by the chat
// composer. Kept in its own module so the textarea composer and the TipTap
// skill composer can both reuse them without an import cycle.
//
// The menu has two levels. The top level lists connected connectors' command
// groups (a discoverability scaffold) above the current agent's skills; opening
// a connector drills into a drawer of that connector's curated commands. Picking
// any leaf inserts text into the composer.
import {
  IconChevronLeft,
  IconChevronRight,
  IconFileText,
} from "@tabler/icons-react";
import { cn, PopoverContent } from "@vm0/ui";
import type { ZeroAgentCustomSkill } from "@vm0/api-contracts/contracts/zero-agents";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { ConnectorCommand } from "./connector-commands.ts";
import { Link } from "../router/link.tsx";

export interface SlashSkillRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerSlashSkill extends ZeroAgentCustomSkill {
  readonly token: string;
}

// A connector and its curated commands, paired with the connector's display
// label resolved from the connector registry.
export interface SlashConnectorGroup {
  readonly connectorType: ConnectorType;
  readonly label: string;
  readonly commands: readonly ConnectorCommand[];
}

// One navigable row in the menu. The composer builds the ordered list for the
// current level and the menu renders/keys off it, so indices always agree.
export type SlashMenuItem =
  | { readonly kind: "connector"; readonly group: SlashConnectorGroup }
  | { readonly kind: "skill"; readonly skill: ComposerSlashSkill }
  | {
      readonly kind: "command";
      readonly command: ConnectorCommand;
      readonly index: number;
    };

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

function slashMenuItemId(item: SlashMenuItem): string {
  if (item.kind === "connector") {
    return `slash-connector-option-${item.group.connectorType}`;
  }
  if (item.kind === "command") {
    return `slash-command-option-${item.index}`;
  }
  return slashSkillOptionId(item.skill.name);
}

export function scrollSlashMenuItemIntoView(
  item: SlashMenuItem | undefined,
): void {
  if (!item) {
    return;
  }

  window.requestAnimationFrame(() => {
    const option = document.getElementById(slashMenuItemId(item));
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

const SECTION_LABEL_CLASS =
  "px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wide " +
  "text-muted-foreground";

function SlashMenuRow({
  item,
  index,
  selectedIndex,
  onSelect,
}: {
  readonly item: SlashMenuItem;
  readonly index: number;
  readonly selectedIndex: number;
  readonly onSelect: (item: SlashMenuItem) => void;
}) {
  const selected = index === selectedIndex;
  return (
    <button
      id={slashMenuItemId(item)}
      type="button"
      className={cn(
        "flex w-full items-center rounded px-2 py-1.5 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
      // preventDefault keeps focus in the editor; the menu is keyboard-driven
      // from the editor's keydown handler.
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect(item);
      }}
    >
      {item.kind === "skill" ? (
        <span className="truncate font-mono text-sm text-primary">
          {item.skill.token}
        </span>
      ) : item.kind === "connector" ? (
        <>
          <span className="truncate text-sm text-popover-foreground">
            {item.group.label}
          </span>
          <IconChevronRight
            size={16}
            stroke={1.8}
            className="ml-auto shrink-0 text-muted-foreground"
          />
        </>
      ) : (
        <span className="truncate text-sm text-popover-foreground">
          {item.command.label}
        </span>
      )}
    </button>
  );
}

export function SlashSkillMenu({
  items,
  mode,
  drawerLabel,
  loading,
  selectedIndex,
  showSkillsPageLink,
  onSelect,
  onBack,
}: {
  readonly items: readonly SlashMenuItem[];
  readonly mode: "top" | "drawer";
  readonly drawerLabel: string | null;
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly showSkillsPageLink: boolean;
  readonly onSelect: (item: SlashMenuItem) => void;
  readonly onBack: () => void;
}) {
  const connectorItems = items
    .map((item, index) => {
      return { item, index };
    })
    .filter((entry) => {
      return entry.item.kind === "connector";
    });
  const skillItems = items
    .map((item, index) => {
      return { item, index };
    })
    .filter((entry) => {
      return entry.item.kind === "skill";
    });
  // Only show the Skills section header when it has something to say, so a menu
  // that is all connector commands doesn't render a dangling "Skills" label.
  const showSkillsSection =
    loading || skillItems.length > 0 || connectorItems.length === 0;

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={12}
      // Keep focus in the TipTap editor: the menu's keyboard navigation is
      // handled there, so the popover must never steal focus when it opens.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
      className="flex max-h-80 w-[260px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0"
      data-testid="slash-skill-menu"
    >
      {mode === "drawer" ? (
        <>
          <button
            type="button"
            className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-left text-[0.8125rem] font-medium text-popover-foreground"
            onMouseDown={(event) => {
              event.preventDefault();
              onBack();
            }}
          >
            <IconChevronLeft
              size={16}
              stroke={1.8}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate">{drawerLabel}</span>
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {items.map((item, index) => {
              return (
                <SlashMenuRow
                  key={slashMenuItemId(item)}
                  item={item}
                  index={index}
                  selectedIndex={selectedIndex}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        </>
      ) : (
        <>
          {connectorItems.length > 0 && (
            <>
              <div className={SECTION_LABEL_CLASS}>Commands</div>
              <div className="px-1.5 pb-1">
                {connectorItems.map((entry) => {
                  return (
                    <SlashMenuRow
                      key={slashMenuItemId(entry.item)}
                      item={entry.item}
                      index={entry.index}
                      selectedIndex={selectedIndex}
                      onSelect={onSelect}
                    />
                  );
                })}
              </div>
            </>
          )}
          {showSkillsSection && (
            <>
              <div className={SECTION_LABEL_CLASS}>Skills</div>
              {loading ? (
                <div className="px-2.5 py-2 text-sm text-muted-foreground">
                  Loading skills...
                </div>
              ) : skillItems.length > 0 ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
                  {skillItems.map((entry) => {
                    return (
                      <SlashMenuRow
                        key={slashMenuItemId(entry.item)}
                        item={entry.item}
                        index={entry.index}
                        selectedIndex={selectedIndex}
                        onSelect={onSelect}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="px-2.5 pt-1 pb-2.5 text-sm text-muted-foreground">
                  No matching skills
                </div>
              )}
            </>
          )}
        </>
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
    </PopoverContent>
  );
}
