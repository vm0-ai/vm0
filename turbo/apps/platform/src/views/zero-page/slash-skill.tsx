// Slash-skill domain helpers and the suggestion menu, shared by the chat
// composer. Kept in its own module so the textarea composer and the TipTap
// skill composer can both reuse them without an import cycle.
//
// The menu is a two-pane "Commands" block above the agent's skills. The left
// rail lists connected connectors; highlighting (selecting/hovering) a connector
// auto-expands its curated commands in the right pane — no drill-in or back step.
// Picking a command or skill inserts text into the composer.
import { IconChevronRight, IconFileText } from "@tabler/icons-react";
import { cn, PopoverContent } from "@vm0/ui";
import type { ZeroAgentCustomSkill } from "@vm0/api-contracts/contracts/zero-agents";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { ConnectorCommand } from "./connector-commands.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
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

// One navigable row in the menu's left rail: a connector or a skill. Commands
// live in the right pane and are navigated separately (see SlashMenuColumn).
export type SlashMenuItem =
  | { readonly kind: "connector"; readonly group: SlashConnectorGroup }
  | { readonly kind: "skill"; readonly skill: ComposerSlashSkill };

export type SlashMenuColumn = "rail" | "detail";

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

export function connectorOptionId(connectorType: ConnectorType): string {
  return `slash-connector-option-${connectorType}`;
}

export function skillOptionId(skillName: string): string {
  return `slash-skill-option-${skillName}`;
}

export function commandOptionId(index: number): string {
  return `slash-command-option-${index}`;
}

export function scrollSlashOptionIntoView(elementId: string): void {
  window.requestAnimationFrame(() => {
    const option = document.getElementById(elementId);
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

const SECTION_LABEL_CLASS =
  "px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wide " +
  "text-muted-foreground";

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors";

// Left rail: one row per connected connector. Highlighting a connector (keyboard
// rail selection or hover) makes it the active connector whose commands show on
// the right.
function SlashConnectorRail({
  connectorGroups,
  activeConnectorType,
  onActivate,
}: {
  readonly connectorGroups: readonly SlashConnectorGroup[];
  readonly activeConnectorType: ConnectorType | null;
  readonly onActivate: (connectorType: ConnectorType) => void;
}) {
  return (
    <div className="flex w-[112px] shrink-0 flex-col border-r border-border/60 pr-1">
      {connectorGroups.map((group) => {
        const active = group.connectorType === activeConnectorType;
        return (
          <button
            id={connectorOptionId(group.connectorType)}
            key={group.connectorType}
            type="button"
            className={cn(
              ROW_CLASS,
              active ? "bg-accent" : "hover:bg-accent/60",
            )}
            onMouseEnter={() => {
              onActivate(group.connectorType);
            }}
            // preventDefault keeps focus in the editor; the menu is keyboard
            // driven from the editor's keydown handler.
            onMouseDown={(event) => {
              event.preventDefault();
              onActivate(group.connectorType);
            }}
          >
            <ConnectorIcon type={group.connectorType} size={18} />
            <span className="truncate text-sm text-popover-foreground">
              {group.label}
            </span>
            <IconChevronRight
              size={16}
              stroke={1.8}
              className="ml-auto shrink-0 text-muted-foreground"
            />
          </button>
        );
      })}
    </div>
  );
}

// Right pane: the active connector's curated commands.
function SlashCommandPane({
  commands,
  selected,
  selectedIndex,
  onSelect,
}: {
  readonly commands: readonly ConnectorCommand[];
  readonly selected: boolean;
  readonly selectedIndex: number;
  readonly onSelect: (command: ConnectorCommand) => void;
}) {
  return (
    <div className="min-w-0 flex-1 pl-1">
      {commands.map((command, index) => {
        return (
          <button
            id={commandOptionId(index)}
            key={command.label}
            type="button"
            className={cn(
              ROW_CLASS,
              selected && index === selectedIndex
                ? "bg-accent"
                : "hover:bg-accent/60",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(command);
            }}
          >
            <span className="truncate text-sm text-popover-foreground">
              {command.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SlashSkillRow({
  skill,
  selected,
  onSelect,
}: {
  readonly skill: ComposerSlashSkill;
  readonly selected: boolean;
  readonly onSelect: (skill: ComposerSlashSkill) => void;
}) {
  return (
    <button
      id={skillOptionId(skill.name)}
      type="button"
      className={cn(ROW_CLASS, selected ? "bg-accent" : "hover:bg-accent/60")}
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
}

function SlashSkillsPageLink() {
  return (
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
  );
}

export function SlashSkillMenu({
  connectorGroups,
  activeConnectorType,
  commands,
  skills,
  column,
  selectedIndex,
  railSkillStartIndex,
  loading,
  showSkillsPageLink,
  onActivateConnector,
  onSelectCommand,
  onSelectSkill,
}: {
  readonly connectorGroups: readonly SlashConnectorGroup[];
  readonly activeConnectorType: ConnectorType | null;
  readonly commands: readonly ConnectorCommand[];
  readonly skills: readonly ComposerSlashSkill[];
  readonly column: SlashMenuColumn;
  readonly selectedIndex: number;
  // Rail index where skills begin (after the connectors), so a rail selection
  // index maps to the right skill row.
  readonly railSkillStartIndex: number;
  readonly loading: boolean;
  readonly showSkillsPageLink: boolean;
  readonly onActivateConnector: (connectorType: ConnectorType) => void;
  readonly onSelectCommand: (command: ConnectorCommand) => void;
  readonly onSelectSkill: (skill: ComposerSlashSkill) => void;
}) {
  const hasConnectors = connectorGroups.length > 0;
  // Show the Skills header only when it has something to say, so a connectors-
  // only menu doesn't render a dangling "Skills" label.
  const showSkillsSection = loading || skills.length > 0 || !hasConnectors;

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
      className="flex max-h-80 w-[300px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0"
      data-testid="slash-skill-menu"
    >
      {hasConnectors && (
        <>
          <div className={SECTION_LABEL_CLASS}>Commands</div>
          <div className="flex px-1.5 pb-1">
            <SlashConnectorRail
              connectorGroups={connectorGroups}
              activeConnectorType={activeConnectorType}
              onActivate={onActivateConnector}
            />
            <SlashCommandPane
              commands={commands}
              selected={column === "detail"}
              selectedIndex={selectedIndex}
              onSelect={onSelectCommand}
            />
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
          ) : skills.length > 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
              {skills.map((skill, index) => {
                return (
                  <SlashSkillRow
                    key={skill.name}
                    skill={skill}
                    selected={
                      column === "rail" &&
                      selectedIndex === railSkillStartIndex + index
                    }
                    onSelect={onSelectSkill}
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
      {showSkillsPageLink && <SlashSkillsPageLink />}
    </PopoverContent>
  );
}
