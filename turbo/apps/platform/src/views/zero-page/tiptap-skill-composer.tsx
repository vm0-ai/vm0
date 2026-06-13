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
  openSlashConnectorType$,
  setOpenSlashConnectorType$,
} from "../../signals/zero-page/zero-chat-composer.ts";
import {
  buildComposerSlashSkills,
  findActiveSlashSkillRange,
  matchesSkillQuery,
  scrollSlashMenuItemIntoView,
  skillTokenPattern,
  SlashSkillMenu,
  type ComposerSlashSkill,
  type SlashConnectorGroup,
  type SlashMenuItem,
  type SlashSkillRange,
} from "./slash-skill.tsx";
import { CONNECTOR_COMMAND_GROUPS } from "./connector-commands.ts";
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

interface SlashMenuKeyContext {
  readonly items: readonly SlashMenuItem[];
  readonly selectedIndex: number;
  readonly setSelectedIndex: (index: number) => void;
  readonly setCaretIndex: (index: number) => void;
  readonly onSelect: (item: SlashMenuItem) => void;
  // Set while a connector drawer is open; Escape returns to the top level
  // instead of closing the menu.
  readonly onBack: (() => void) | null;
}

// Drives the suggestion menu from the keyboard. Returns true when it consumes the
// event so the editor can stop handling that keystroke.
function handleSlashMenuKey(
  event: KeyboardEvent,
  ctx: SlashMenuKeyContext,
): boolean {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = Math.min(
      ctx.selectedIndex + 1,
      Math.max(ctx.items.length - 1, 0),
    );
    ctx.setSelectedIndex(next);
    scrollSlashMenuItemIntoView(ctx.items[next]);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    const next = Math.max(ctx.selectedIndex - 1, 0);
    ctx.setSelectedIndex(next);
    scrollSlashMenuItemIntoView(ctx.items[next]);
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && ctx.items[0]) {
    event.preventDefault();
    const item = ctx.items[Math.min(ctx.selectedIndex, ctx.items.length - 1)];
    if (item) {
      ctx.onSelect(item);
    }
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (ctx.onBack) {
      ctx.onBack();
    } else {
      ctx.setCaretIndex(-1);
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
  // Drop back to the menu's top level when the content changes, so a connector
  // drawer never silently reopens on the next `/`.
  readonly resetConnectorDrawer: () => void;
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
      params.resetConnectorDrawer();
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
  readonly menuItems: readonly SlashMenuItem[];
  readonly menuMode: "top" | "drawer";
  readonly openGroup: SlashConnectorGroup | null;
  readonly showMenu: boolean;
}

// Builds the ordered rows for the current menu level plus whether the menu is
// shown, from the active slash query, the agent's skills, and the connected
// connector groups. Kept pure so the component stays small. The menu renders and
// keys off the same array, so the keyboard selection index always agrees.
function buildSlashMenuModel({
  slashRange,
  composerSkills,
  connectorGroups,
  openConnectorType,
  isLoadingOrgSkills,
  showSkillsPageLink,
}: {
  readonly slashRange: SlashSkillRange | null;
  readonly composerSkills: readonly ComposerSlashSkill[];
  readonly connectorGroups: readonly SlashConnectorGroup[];
  readonly openConnectorType: ConnectorType | null;
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
  const openGroup =
    connectorGroups.find((group) => {
      return group.connectorType === openConnectorType;
    }) ?? null;
  const menuItems: readonly SlashMenuItem[] = openGroup
    ? openGroup.commands.map((command, index) => {
        return { kind: "command", command, index } as const;
      })
    : [
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
      filteredConnectorGroups.length > 0 ||
      openGroup !== null);
  return {
    menuItems,
    menuMode: openGroup ? "drawer" : "top",
    openGroup,
    showMenu,
  };
}

interface SlashSelectContext {
  readonly editor: Editor | null;
  readonly slashRange: SlashSkillRange | null;
  readonly input: string;
  readonly onDraftChange: (() => void) | undefined;
  readonly openDrawer: (connectorType: ConnectorType) => void;
}

// Applies a chosen menu row: connectors open their command drawer; skills and
// commands insert their text via the shared insertion path.
function selectSlashMenuItem(
  item: SlashMenuItem,
  ctx: SlashSelectContext,
): void {
  if (item.kind === "connector") {
    ctx.openDrawer(item.group.connectorType);
    return;
  }
  if (!ctx.editor || !ctx.slashRange) {
    return;
  }
  if (item.kind === "skill") {
    insertSkillToken(ctx.editor, ctx.slashRange, ctx.input, item.skill);
  } else {
    insertPromptText(ctx.editor, ctx.slashRange, item.command.prompt);
  }
  ctx.onDraftChange?.();
}

interface ComposerKeyContext {
  readonly showMenu: boolean;
  readonly menuItems: readonly SlashMenuItem[];
  readonly selectedIndex: number;
  readonly setSelectedIndex: (index: number) => void;
  readonly setCaretIndex: (index: number) => void;
  readonly onSelect: (item: SlashMenuItem) => void;
  readonly onBack: (() => void) | null;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
}

// Lets the open suggestion menu consume navigation/selection keys first, then
// defers to the parent for send / global shortcuts.
function handleComposerKeyDown(
  event: KeyboardEvent,
  ctx: ComposerKeyContext,
): boolean {
  if (
    ctx.showMenu &&
    handleSlashMenuKey(event, {
      items: ctx.menuItems,
      selectedIndex: ctx.selectedIndex,
      setSelectedIndex: ctx.setSelectedIndex,
      setCaretIndex: ctx.setCaretIndex,
      onSelect: ctx.onSelect,
      onBack: ctx.onBack,
    })
  ) {
    return true;
  }
  // Defer to the parent for send / global shortcuts. If it consumes the event
  // (e.g. Enter-to-send) it calls preventDefault; otherwise the editor handles
  // the keystroke (e.g. Shift+Enter or mobile Enter inserts a newline).
  ctx.onKeyDown(event);
  return event.defaultPrevented;
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
  menuItems,
  menuMode,
  drawerLabel,
  loading,
  selectedIndex,
  showSkillsPageLink,
  onSelect,
  onBack,
}: {
  readonly editor: Editor | null;
  readonly input: string;
  readonly sending: boolean | undefined;
  readonly showMenu: boolean;
  readonly menuItems: readonly SlashMenuItem[];
  readonly menuMode: "top" | "drawer";
  readonly drawerLabel: string | null;
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly showSkillsPageLink: boolean;
  readonly onSelect: (item: SlashMenuItem) => void;
  readonly onBack: () => void;
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
          items={menuItems}
          mode={menuMode}
          drawerLabel={drawerLabel}
          loading={loading}
          selectedIndex={selectedIndex}
          showSkillsPageLink={showSkillsPageLink}
          onSelect={onSelect}
          onBack={onBack}
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
  const selectedSkillIndex = useGet(selectedSlashSkillIndex$);
  const setSelectedSkillIndex = useSet(setSelectedSlashSkillIndex$);
  // Which connector drawer is open, or null at the top level. Lives in a signal
  // (React state is restricted here) and resets on content change so reopening
  // `/` always starts at the top level.
  const openConnectorType = useGet(openSlashConnectorType$);
  const setOpenConnectorType = useSet(setOpenSlashConnectorType$);
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
  const { menuItems, menuMode, openGroup, showMenu } = buildSlashMenuModel({
    slashRange,
    composerSkills,
    connectorGroups,
    openConnectorType,
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
      setSelectedSkillIndex,
      setCaretIndex,
      resetConnectorDrawer: () => {
        if (openConnectorType !== null) {
          setOpenConnectorType(null);
        }
      },
      onEditorKeyDown: (event) => {
        return handleComposerKeyDown(event, {
          showMenu,
          menuItems,
          selectedIndex: selectedSkillIndex,
          setSelectedIndex: setSelectedSkillIndex,
          setCaretIndex,
          onSelect: selectItem,
          onBack: openGroup ? closeConnectorDrawer : null,
          onKeyDown,
        });
      },
    }),
  );

  if (editor) {
    syncEditorState(editor, skillNames, input);
  }

  function openConnectorDrawer(connectorType: ConnectorType): void {
    setOpenConnectorType(connectorType);
    setSelectedSkillIndex(0);
  }

  function closeConnectorDrawer(): void {
    setOpenConnectorType(null);
    setSelectedSkillIndex(0);
  }

  function selectItem(item: SlashMenuItem): void {
    selectSlashMenuItem(item, {
      editor,
      slashRange,
      input,
      onDraftChange,
      openDrawer: openConnectorDrawer,
    });
  }

  return (
    <SlashComposerShell
      editor={editor}
      input={input}
      sending={sending}
      showMenu={showMenu}
      menuItems={menuItems}
      menuMode={menuMode}
      drawerLabel={openGroup ? openGroup.label : null}
      loading={isLoadingOrgSkills}
      selectedIndex={selectedSkillIndex}
      showSkillsPageLink={showSkillsPageLink}
      onSelect={selectItem}
      onBack={closeConnectorDrawer}
    />
  );
}
