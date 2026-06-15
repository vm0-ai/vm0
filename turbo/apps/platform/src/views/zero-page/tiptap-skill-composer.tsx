// TipTap-based chat composer input. Skill mentions are colored with ProseMirror
// inline decorations rather than a transparent-textarea + colored overlay, so the
// color lives in the same layer as the text and moves/scrolls with it — there is
// no second layer to keep aligned when the input scrolls (issue #17539).
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useEditor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Popover, PopoverAnchor, type KeyboardEventLike } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { currentChatAgent$ } from "../../signals/agent-chat.ts";
import { orgSkills$ } from "../../signals/skills-page/skills-signals.ts";
import { allConnectorTypes$ } from "../../signals/zero-page/settings/connectors.ts";
import {
  slashSkillCaretIndex$,
  setSlashSkillCaretIndex$,
  selectedSlashSkillIndex$,
  setSelectedSlashSkillIndex$,
  activeSlashConnectorType$,
  setActiveSlashConnectorType$,
  slashMenuColumn$,
  setSlashMenuColumn$,
} from "../../signals/zero-page/zero-chat-composer.ts";
import {
  buildComposerSlashSkills,
  commandOptionId,
  connectorOptionId,
  findActiveSlashSkillRange,
  matchesSkillQuery,
  scrollSlashOptionIntoView,
  skillOptionId,
  skillTokenPattern,
  SlashSkillMenu,
  type ComposerSlashSkill,
  type SlashConnectorGroup,
  type SlashMenuColumn,
  type SlashMenuItem,
  type SlashSkillRange,
} from "./slash-skill.tsx";
import {
  CONNECTOR_COMMAND_GROUPS,
  type ConnectorCommand,
} from "./connector-commands.ts";
import type { ComposerPasteEvent } from "./composer-input-types.ts";

// Match the textarea metrics so swapping inputs is visually seamless. The editor
// element itself scrolls (single layer), so there is no overlay to sync.
const EDITOR_CONTENT_CLASS =
  "w-full min-h-[96px] max-h-[200px] overflow-y-auto whitespace-pre-wrap " +
  "break-words px-4 pt-4 pb-0 text-[0.9375rem] leading-6 text-foreground " +
  "caret-foreground outline-none focus:outline-none [&_p]:m-0 " +
  "selection:bg-primary/20";

const SKILL_HIGHLIGHT_CLASS = "text-primary";

// Plain text -> document: one paragraph per line. Skill coloring is applied by
// the decoration plugin, so the document stays plain text.
function valueToDoc(value: string): JSONContent {
  const content: JSONContent[] = value.split("\n").map((line) => {
    return line.length > 0
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph" };
  });
  return { type: "doc", content };
}

// Document -> plain string, with block and hard breaks as newlines, so the rest
// of the chat keeps a plain string value.
function docToString(editor: Editor): string {
  return editor.getText({
    blockSeparator: "\n",
    textSerializers: {
      hardBreak: () => {
        return "\n";
      },
    },
  });
}

// Caret position as an offset into the serialized string, so the existing
// string-based slash-range detection can be reused unchanged.
function caretStringIndex(editor: Editor): number {
  const head = editor.state.selection.head;
  return editor.state.doc.textBetween(0, head, "\n", (leafNode) => {
    return leafNode.type.name === "hardBreak" ? "\n" : "";
  }).length;
}

function buildSkillDecorations(
  doc: ProseMirrorNode,
  skillNames: readonly string[],
): DecorationSet {
  const pattern = skillTokenPattern(skillNames);
  if (!pattern) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const text = node.text;
    if (!node.isText || !text) {
      return;
    }
    for (const match of text.matchAll(pattern)) {
      const start = pos + (match.index ?? 0);
      decorations.push(
        Decoration.inline(start, start + match[0].length, {
          class: SKILL_HIGHLIGHT_CLASS,
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

interface SkillHighlightStorage {
  skillNames: readonly string[];
}

// Colors `/skill` tokens via inline decorations. The skill list is read from
// mutable storage (kept current by the component) so the editor never has to be
// rebuilt when the list loads or changes.
const SkillHighlight = Extension.create<
  { skillNames: readonly string[] },
  SkillHighlightStorage
>({
  name: "skillHighlight",
  addOptions() {
    return { skillNames: [] };
  },
  addStorage() {
    return { skillNames: this.options.skillNames };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: new PluginKey("skillHighlight"),
        props: {
          decorations(state: EditorState) {
            return buildSkillDecorations(state.doc, storage.skillNames);
          },
        },
      }),
    ];
  },
});

const STARTER_KIT = StarterKit.configure({
  bold: false,
  italic: false,
  strike: false,
  code: false,
  codeBlock: false,
  heading: false,
  bulletList: false,
  orderedList: false,
  listItem: false,
  blockquote: false,
  horizontalRule: false,
  link: false,
  underline: false,
  trailingNode: false,
});

function isIOS(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// Replace the active `/query` text with the chosen token (plus a trailing space
// unless one already follows). The decoration plugin colors it automatically.
function insertSkillToken(
  editor: Editor,
  slashRange: SlashSkillRange,
  input: string,
  skill: ComposerSlashSkill,
): void {
  const head = editor.state.selection.head;
  const span = slashRange.end - slashRange.start;
  const suffix = input.slice(slashRange.end).startsWith(" ") ? "" : " ";
  editor
    .chain()
    .focus()
    .insertContentAt({ from: head - span, to: head }, [
      { type: "text", text: `/${skill.name}${suffix}` },
    ])
    .run();
}

// Replace the active `/query` text with a plain natural-language prompt. Unlike
// a skill token there is no placeholder selection — the caret lands at the end of
// the inserted text, ready to send or to keep typing (e.g. "Create issue: ").
function insertPromptText(
  editor: Editor,
  slashRange: SlashSkillRange,
  text: string,
): void {
  const head = editor.state.selection.head;
  const span = slashRange.end - slashRange.start;
  editor
    .chain()
    .focus()
    .insertContentAt({ from: head - span, to: head }, [{ type: "text", text }])
    .run();
}

// Two-column keyboard navigation over the slash menu. The "rail" column holds
// connectors then skills; the "detail" column holds the active connector's
// commands. Returns true when it consumes the event.
interface SlashMenuKeyContext {
  readonly column: SlashMenuColumn;
  readonly railCount: number;
  readonly commandCount: number;
  readonly selectedIndex: number;
  readonly railItemIsConnector: (index: number) => boolean;
  readonly moveSelection: (next: number) => void;
  readonly enterDetail: () => void;
  readonly exitDetail: () => void;
  readonly selectRailAt: (index: number) => void;
  readonly selectCommandAt: (index: number) => void;
  readonly close: () => void;
}

function handleSlashMenuKey(
  event: KeyboardEvent,
  ctx: SlashMenuKeyContext,
): boolean {
  const length = ctx.column === "detail" ? ctx.commandCount : ctx.railCount;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    ctx.moveSelection(Math.min(ctx.selectedIndex + 1, Math.max(length - 1, 0)));
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    ctx.moveSelection(Math.max(ctx.selectedIndex - 1, 0));
    return true;
  }
  if (event.key === "ArrowRight") {
    if (
      ctx.column === "rail" &&
      ctx.railItemIsConnector(ctx.selectedIndex) &&
      ctx.commandCount > 0
    ) {
      event.preventDefault();
      ctx.enterDetail();
      return true;
    }
    return false;
  }
  if (event.key === "ArrowLeft") {
    if (ctx.column === "detail") {
      event.preventDefault();
      ctx.exitDetail();
      return true;
    }
    return false;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    if (ctx.column === "detail") {
      if (ctx.commandCount === 0) {
        return false;
      }
      event.preventDefault();
      ctx.selectCommandAt(Math.min(ctx.selectedIndex, ctx.commandCount - 1));
      return true;
    }
    if (ctx.railCount === 0) {
      return false;
    }
    event.preventDefault();
    ctx.selectRailAt(Math.min(ctx.selectedIndex, ctx.railCount - 1));
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (ctx.column === "detail") {
      ctx.exitDetail();
    } else {
      ctx.close();
    }
    return true;
  }
  return false;
}

interface EditorOptionsParams {
  readonly input: string;
  readonly skillNames: readonly string[];
  readonly autoFocus: boolean | undefined;
  readonly onInputChange: (value: string) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
  readonly setInputRef: ((el: HTMLElement | null) => void) | undefined;
  readonly setSelectedSkillIndex: (index: number) => void;
  readonly setCaretIndex: (index: number) => void;
  // Reset the menu's two-pane state (active connector + focused column) when the
  // content changes, so reopening `/` always starts fresh on the rail.
  readonly resetSlashMenuState: () => void;
  readonly onEditorKeyDown: (event: KeyboardEvent) => boolean;
}

// Built fresh each render; useEditor applies it via setOptions so the handlers
// always close over the latest props/state (no refs needed).
function buildEditorOptions(
  params: EditorOptionsParams,
): Parameters<typeof useEditor>[0] {
  return {
    extensions: [
      STARTER_KIT,
      SkillHighlight.configure({ skillNames: params.skillNames }),
    ],
    content: valueToDoc(params.input),
    autofocus: params.autoFocus && !isIOS() ? "end" : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: EDITOR_CONTENT_CLASS },
      handleKeyDown: (_view, event) => {
        return params.onEditorKeyDown(event);
      },
      handlePaste: (view, event) => {
        params.onPaste({
          clipboardData: event.clipboardData,
          currentTarget: view.dom,
          preventDefault: () => {
            event.preventDefault();
          },
        });
        return event.defaultPrevented;
      },
    },
    onUpdate: ({ editor }) => {
      const value = docToString(editor);
      if (value !== params.input) {
        params.onInputChange(value);
      }
      params.setSelectedSkillIndex(0);
      params.resetSlashMenuState();
      params.setCaretIndex(caretStringIndex(editor));
    },
    onSelectionUpdate: ({ editor }) => {
      params.setCaretIndex(caretStringIndex(editor));
    },
    onCreate: ({ editor }) => {
      params.setInputRef?.(editor.view.dom);
    },
    onDestroy: () => {
      params.setInputRef?.(null);
    },
  };
}

// Keep the highlight plugin's skill list current without rebuilding the editor
// (decorations recompute on the next transaction), and reconcile the value when it
// changes outside of typing (draft restore, the send-clear, template insertion).
// Guarded so typing — where the serialized value already matches — never resets the
// caret. shouldRerenderOnTransaction is off, so this never triggers a React re-render.
function syncEditorState(
  editor: Editor,
  skillNames: readonly string[],
  input: string,
): void {
  const storage = (
    editor.storage as unknown as Record<
      string,
      SkillHighlightStorage | undefined
    >
  ).skillHighlight;
  if (storage) {
    storage.skillNames = skillNames;
  }
  if (docToString(editor) !== input) {
    editor.commands.setContent(valueToDoc(input), { emitUpdate: false });
  }
}

// Connected connectors that have a curated command group, gated by the feature
// switch. The display label comes from the connector registry; only connected
// connectors appear so the menu never offers a command the user can't run.
function buildConnectorGroups(
  enabled: boolean,
  connectorStatuses: readonly {
    readonly type: ConnectorType;
    readonly connected: boolean;
    readonly label: string;
  }[],
): readonly SlashConnectorGroup[] {
  if (!enabled) {
    return [];
  }
  return CONNECTOR_COMMAND_GROUPS.flatMap((group) => {
    const status = connectorStatuses.find((connector) => {
      return connector.type === group.connectorType;
    });
    if (!status || !status.connected) {
      return [];
    }
    return [
      {
        connectorType: group.connectorType,
        label: status.label,
        commands: group.commands,
      },
    ];
  });
}

interface SlashMenuModel {
  readonly filteredConnectorGroups: readonly SlashConnectorGroup[];
  readonly suggestions: readonly ComposerSlashSkill[];
  readonly railItems: readonly SlashMenuItem[];
  readonly activeGroup: SlashConnectorGroup | null;
  readonly activeRailIndex: number;
  readonly commands: readonly ConnectorCommand[];
  readonly column: SlashMenuColumn;
  readonly showMenu: boolean;
}

// Builds the two-pane menu model from the active slash query, the agent's
// skills, the connected connector groups, and the current active connector /
// focused column. Kept pure so the component stays small. The menu renders and
// keys off the same derived arrays, so the keyboard selection index always
// agrees with what is shown.
function buildSlashMenuModel({
  slashRange,
  composerSkills,
  connectorGroups,
  activeConnectorType,
  column,
  isLoadingOrgSkills,
  showSkillsPageLink,
}: {
  readonly slashRange: SlashSkillRange | null;
  readonly composerSkills: readonly ComposerSlashSkill[];
  readonly connectorGroups: readonly SlashConnectorGroup[];
  readonly activeConnectorType: ConnectorType | null;
  readonly column: SlashMenuColumn;
  readonly isLoadingOrgSkills: boolean;
  readonly showSkillsPageLink: boolean;
}): SlashMenuModel {
  const query = slashRange?.query ?? null;
  const suggestions =
    query === null
      ? []
      : composerSkills.filter((skill) => {
          return matchesSkillQuery(skill, query);
        });
  const filteredConnectorGroups =
    query === null
      ? []
      : connectorGroups.filter((group) => {
          return group.label.toLowerCase().includes(query.toLowerCase());
        });
  // The active connector (whose commands fill the right pane) follows the user's
  // choice, defaulting to the first connector so the pane is never empty.
  const activeGroup =
    filteredConnectorGroups.find((group) => {
      return group.connectorType === activeConnectorType;
    }) ??
    filteredConnectorGroups[0] ??
    null;
  const activeRailIndex = activeGroup
    ? filteredConnectorGroups.findIndex((group) => {
        return group.connectorType === activeGroup.connectorType;
      })
    : 0;
  const commands = activeGroup?.commands ?? [];
  const railItems: readonly SlashMenuItem[] = [
    ...filteredConnectorGroups.map((group) => {
      return { kind: "connector", group } as const;
    }),
    ...suggestions.map((skill) => {
      return { kind: "skill", skill } as const;
    }),
  ];
  const showMenu =
    slashRange !== null &&
    (isLoadingOrgSkills ||
      composerSkills.length > 0 ||
      showSkillsPageLink ||
      filteredConnectorGroups.length > 0);
  return {
    filteredConnectorGroups,
    suggestions,
    railItems,
    activeGroup,
    activeRailIndex,
    commands,
    // The detail column only makes sense when the active connector has commands.
    column: commands.length > 0 ? column : "rail",
    showMenu,
  };
}

// Presentational shell: the TipTap editor with its placeholder, anchored to the
// Radix Popover (Floating UI) that positions the slash menu cross-browser above
// the input. `open` is fully controlled by composer state, so Escape/typing
// close it via showMenu.
function SlashComposerShell({
  editor,
  input,
  sending,
  showMenu,
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
  readonly editor: Editor | null;
  readonly input: string;
  readonly sending: boolean | undefined;
  readonly showMenu: boolean;
  readonly connectorGroups: readonly SlashConnectorGroup[];
  readonly activeConnectorType: ConnectorType | null;
  readonly commands: readonly ConnectorCommand[];
  readonly skills: readonly ComposerSlashSkill[];
  readonly column: SlashMenuColumn;
  readonly selectedIndex: number;
  readonly railSkillStartIndex: number;
  readonly loading: boolean;
  readonly showSkillsPageLink: boolean;
  readonly onActivateConnector: (connectorType: ConnectorType) => void;
  readonly onSelectCommand: (command: ConnectorCommand) => void;
  readonly onSelectSkill: (skill: ComposerSlashSkill) => void;
}) {
  return (
    <Popover open={showMenu}>
      <PopoverAnchor asChild>
        <div className="relative min-h-[96px]">
          {input === "" && (
            <div
              className="pointer-events-none absolute left-0 top-0 px-4 pt-4 text-[0.9375rem] leading-6 text-muted-foreground/40"
              aria-hidden="true"
            >
              {sending
                ? "Type your next message…"
                : "Ask me to automate workflows, manage tasks..."}
            </div>
          )}
          <EditorContent editor={editor} />
        </div>
      </PopoverAnchor>
      {showMenu && (
        <SlashSkillMenu
          connectorGroups={connectorGroups}
          activeConnectorType={activeConnectorType}
          commands={commands}
          skills={skills}
          column={column}
          selectedIndex={selectedIndex}
          railSkillStartIndex={railSkillStartIndex}
          loading={loading}
          showSkillsPageLink={showSkillsPageLink}
          onActivateConnector={onActivateConnector}
          onSelectCommand={onSelectCommand}
          onSelectSkill={onSelectSkill}
        />
      )}
    </Popover>
  );
}

export function TiptapSkillComposer({
  input,
  onInputChange,
  onDraftChange,
  sending,
  autoFocus,
  setInputRef,
  onKeyDown,
  onPaste,
}: {
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly onDraftChange: (() => void) | undefined;
  readonly sending: boolean | undefined;
  readonly autoFocus: boolean | undefined;
  readonly setInputRef: ((el: HTMLElement | null) => void) | undefined;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
}) {
  const caretIndex = useGet(slashSkillCaretIndex$);
  const setCaretIndex = useSet(setSlashSkillCaretIndex$);
  const selectedIndex = useGet(selectedSlashSkillIndex$);
  const setSelectedIndex = useSet(setSelectedSlashSkillIndex$);
  // Two-pane state lives in signals (React state is restricted here) and resets
  // on content change so reopening `/` always starts fresh on the rail.
  const activeConnectorType = useGet(activeSlashConnectorType$);
  const setActiveConnectorType = useSet(setActiveSlashConnectorType$);
  const column = useGet(slashMenuColumn$);
  const setColumn = useSet(setSlashMenuColumn$);
  const currentAgent = useLastResolved(currentChatAgent$);
  const features = useLastResolved(featureSwitch$);
  const orgSkillsLoadable = useLastLoadable(orgSkills$);
  const orgSkillsData =
    orgSkillsLoadable.state === "hasData" ? orgSkillsLoadable.data : [];
  const connectorsLoadable = useLastLoadable(allConnectorTypes$);
  const connectorStatuses =
    connectorsLoadable.state === "hasData" ? connectorsLoadable.data : [];

  const composerSkills = buildComposerSlashSkills({
    agentSkillNames: currentAgent?.customSkills ?? [],
    orgSkills: orgSkillsData,
  });
  const skillNames = composerSkills.map((skill) => {
    return skill.name;
  });

  const slashRange = findActiveSlashSkillRange(input, caretIndex);
  const isLoadingOrgSkills = orgSkillsLoadable.state === "loading";
  const showSkillsPageLink = features?.[FeatureSwitchKey.SkillsViewer] ?? false;
  const connectorGroups = buildConnectorGroups(
    features?.[FeatureSwitchKey.ChatConnectorCommands] ?? false,
    connectorStatuses,
  );
  const {
    filteredConnectorGroups,
    suggestions,
    railItems,
    activeGroup,
    activeRailIndex,
    commands,
    column: menuColumn,
    showMenu,
  } = buildSlashMenuModel({
    slashRange,
    composerSkills,
    connectorGroups,
    activeConnectorType,
    column,
    isLoadingOrgSkills,
    showSkillsPageLink,
  });

  // Created once; useEditor refreshes its options via setOptions on every render,
  // so the handlers always close over the latest props/state (no refs needed).
  const editor = useEditor(
    buildEditorOptions({
      input,
      skillNames,
      autoFocus,
      onInputChange,
      onPaste,
      setInputRef,
      setSelectedSkillIndex: setSelectedIndex,
      setCaretIndex,
      resetSlashMenuState: () => {
        if (activeConnectorType !== null) {
          setActiveConnectorType(null);
        }
        if (column !== "rail") {
          setColumn("rail");
        }
      },
      onEditorKeyDown: (event) => {
        return handleEditorKeyDown(event);
      },
    }),
  );

  if (editor) {
    syncEditorState(editor, skillNames, input);
  }

  function activateConnector(connectorType: ConnectorType): void {
    setActiveConnectorType(connectorType);
    setColumn("rail");
    const index = filteredConnectorGroups.findIndex((group) => {
      return group.connectorType === connectorType;
    });
    setSelectedIndex(index >= 0 ? index : 0);
  }

  function moveSelection(next: number): void {
    setSelectedIndex(next);
    if (menuColumn === "detail") {
      scrollSlashOptionIntoView(commandOptionId(next));
      return;
    }
    const item = railItems[next];
    if (item?.kind === "connector") {
      setActiveConnectorType(item.group.connectorType);
      scrollSlashOptionIntoView(connectorOptionId(item.group.connectorType));
    } else if (item?.kind === "skill") {
      scrollSlashOptionIntoView(skillOptionId(item.skill.name));
    }
  }

  function enterDetail(): void {
    if (commands.length === 0) {
      return;
    }
    setColumn("detail");
    setSelectedIndex(0);
    scrollSlashOptionIntoView(commandOptionId(0));
  }

  function exitDetail(): void {
    setColumn("rail");
    setSelectedIndex(activeRailIndex);
  }

  function insertSkill(skill: ComposerSlashSkill): void {
    if (!editor || !slashRange) {
      return;
    }
    insertSkillToken(editor, slashRange, input, skill);
    onDraftChange?.();
  }

  function insertCommand(command: ConnectorCommand): void {
    if (!editor || !slashRange) {
      return;
    }
    insertPromptText(editor, slashRange, command.prompt);
    onDraftChange?.();
  }

  function selectRailAt(index: number): void {
    const item = railItems[index];
    if (!item) {
      return;
    }
    if (item.kind === "connector") {
      activateConnector(item.group.connectorType);
      enterDetail();
    } else {
      insertSkill(item.skill);
    }
  }

  function selectCommandAt(index: number): void {
    const command = commands[index];
    if (command) {
      insertCommand(command);
    }
  }

  function handleEditorKeyDown(event: KeyboardEvent): boolean {
    if (
      showMenu &&
      handleSlashMenuKey(event, {
        column: menuColumn,
        railCount: railItems.length,
        commandCount: commands.length,
        selectedIndex,
        railItemIsConnector: (index) => {
          return railItems[index]?.kind === "connector";
        },
        moveSelection,
        enterDetail,
        exitDetail,
        selectRailAt,
        selectCommandAt,
        close: () => {
          setCaretIndex(-1);
        },
      })
    ) {
      return true;
    }
    // Defer to the parent for send / global shortcuts. If it consumes the event
    // (e.g. Enter-to-send) it calls preventDefault; otherwise the editor handles
    // the keystroke (e.g. Shift+Enter or mobile Enter inserts a newline).
    onKeyDown(event);
    return event.defaultPrevented;
  }

  return (
    <SlashComposerShell
      editor={editor}
      input={input}
      sending={sending}
      showMenu={showMenu}
      connectorGroups={filteredConnectorGroups}
      activeConnectorType={activeGroup ? activeGroup.connectorType : null}
      commands={commands}
      skills={suggestions}
      column={menuColumn}
      selectedIndex={selectedIndex}
      railSkillStartIndex={filteredConnectorGroups.length}
      loading={isLoadingOrgSkills}
      showSkillsPageLink={showSkillsPageLink}
      onActivateConnector={activateConnector}
      onSelectCommand={insertCommand}
      onSelectSkill={insertSkill}
    />
  );
}
