// TipTap-based chat composer input. Skill mentions are colored with ProseMirror
// inline decorations rather than a transparent-textarea + colored overlay, so the
// color lives in the same layer as the text and moves/scrolls with it — there is
// no second layer to keep aligned when the input scrolls (issue #17539).
import { useEffect, useState } from "react";
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
  const currentAgent = useLastResolved(currentChatAgent$);
  const features = useLastResolved(featureSwitch$);
  const orgSkillsLoadable = useLastLoadable(orgSkills$);
  const orgSkillsData =
    orgSkillsLoadable.state === "hasData" ? orgSkillsLoadable.data : [];
  const connectorsLoadable = useLastLoadable(allConnectorTypes$);
  const connectorStatuses =
    connectorsLoadable.state === "hasData" ? connectorsLoadable.data : [];
  // Which connector drawer is open, or null at the top level. Reset whenever the
  // menu closes (effect below) so reopening `/` always starts at the top level.
  const [openConnectorType, setOpenConnectorType] =
    useState<ConnectorType | null>(null);
  const composerSkills = buildComposerSlashSkills({
    agentSkillNames: currentAgent?.customSkills ?? [],
    orgSkills: orgSkillsData,
  });
  const skillNames = composerSkills.map((skill) => {
    return skill.name;
  });

  const slashRange = findActiveSlashSkillRange(input, caretIndex);
  const suggestions = slashRange
    ? composerSkills.filter((skill) => {
        return matchesSkillQuery(skill, slashRange.query);
      })
    : [];

  // Connected connectors that have a curated command group, gated by the feature
  // switch. The display label comes from the connector registry; only connected
  // connectors appear so the menu never offers a command the user can't run.
  const connectorCommandsEnabled =
    features?.[FeatureSwitchKey.ChatConnectorCommands] ?? false;
  const connectorGroups: readonly SlashConnectorGroup[] =
    connectorCommandsEnabled
      ? CONNECTOR_COMMAND_GROUPS.flatMap((group) => {
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
        })
      : [];
  const filteredConnectorGroups = slashRange
    ? connectorGroups.filter((group) => {
        return group.label
          .toLowerCase()
          .includes(slashRange.query.toLowerCase());
      })
    : [];
  const openGroup = openConnectorType
    ? (connectorGroups.find((group) => {
        return group.connectorType === openConnectorType;
      }) ?? null)
    : null;

  // The ordered rows for the current level. The menu renders/keys off the same
  // array, so the keyboard selection index and the rendered rows always agree.
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
  const menuMode: "top" | "drawer" = openGroup ? "drawer" : "top";

  const isLoadingOrgSkills = orgSkillsLoadable.state === "loading";
  const showSkillsPageLink = features?.[FeatureSwitchKey.SkillsViewer] ?? false;
  const showSlashSkillMenu =
    slashRange !== null &&
    (isLoadingOrgSkills ||
      composerSkills.length > 0 ||
      showSkillsPageLink ||
      filteredConnectorGroups.length > 0 ||
      openGroup !== null);

  // The menu's open/close is derived state; when it closes, drop back to the top
  // level so a connector drawer never silently reopens on the next `/`.
  useEffect(() => {
    if (!showSlashSkillMenu && openConnectorType !== null) {
      setOpenConnectorType(null);
    }
  }, [showSlashSkillMenu, openConnectorType]);

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
      onEditorKeyDown: (event) => {
        return handleEditorKeyDown(event);
      },
    }),
  );

  if (editor) {
    syncEditorState(editor, skillNames, input);
  }

  function insertSkill(skill: ComposerSlashSkill): void {
    if (!editor || !slashRange) {
      return;
    }
    insertSkillToken(editor, slashRange, input, skill);
    onDraftChange?.();
  }

  function insertPrompt(command: ConnectorCommand): void {
    if (!editor || !slashRange) {
      return;
    }
    insertPromptText(editor, slashRange, command.prompt);
    onDraftChange?.();
  }

  function openConnectorDrawer(connectorType: ConnectorType): void {
    setOpenConnectorType(connectorType);
    setSelectedSkillIndex(0);
  }

  function closeConnectorDrawer(): void {
    setOpenConnectorType(null);
    setSelectedSkillIndex(0);
  }

  function selectMenuItem(item: SlashMenuItem): void {
    if (item.kind === "connector") {
      openConnectorDrawer(item.group.connectorType);
      return;
    }
    if (item.kind === "skill") {
      insertSkill(item.skill);
      return;
    }
    insertPrompt(item.command);
  }

  function handleEditorKeyDown(event: KeyboardEvent): boolean {
    if (
      showSlashSkillMenu &&
      handleSlashMenuKey(event, {
        items: menuItems,
        selectedIndex: selectedSkillIndex,
        setSelectedIndex: setSelectedSkillIndex,
        setCaretIndex,
        onSelect: selectMenuItem,
        onBack: openGroup ? closeConnectorDrawer : null,
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
    // Radix Popover (Floating UI) positions the menu cross-browser; the anchor
    // is the input region so the menu sits above it. `open` is fully controlled
    // by composer state, so Escape/typing close it via showSlashSkillMenu.
    <Popover open={showSlashSkillMenu}>
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
      {showSlashSkillMenu && (
        <SlashSkillMenu
          items={menuItems}
          mode={menuMode}
          drawerLabel={openGroup ? openGroup.label : null}
          loading={isLoadingOrgSkills}
          selectedIndex={selectedSkillIndex}
          showSkillsPageLink={showSkillsPageLink}
          onSelect={selectMenuItem}
          onBack={closeConnectorDrawer}
        />
      )}
    </Popover>
  );
}
