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
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { currentChatAgent$ } from "../../signals/agent-chat.ts";
import { orgSkills$ } from "../../signals/skills-page/skills-signals.ts";
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
  scrollSlashSkillIntoView,
  skillTokenPattern,
  SlashSkillMenu,
  type ComposerSlashSkill,
  type SlashSkillRange,
} from "./slash-skill.tsx";
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

function isMacKeyboard(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

function serializeTextblockSegment(
  node: ProseMirrorNode,
  from: number,
  to: number,
): string {
  return node.textBetween(from, to, "\n", (leafNode) => {
    return leafNode.type.name === "hardBreak" ? "\n" : "";
  });
}

function resolveMacControlLineNavigation(
  editor: Editor,
  event: KeyboardEvent,
): number | null {
  if (
    !isMacKeyboard() ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key !== "a" && key !== "e") {
    return null;
  }

  const { $head } = editor.state.selection;
  const { parent, parentOffset } = $head;
  if (!parent.isTextblock) {
    return null;
  }

  const beforeCaret = serializeTextblockSegment(parent, 0, parentOffset);
  if (key === "a") {
    const previousBreak = beforeCaret.lastIndexOf("\n");
    return $head.start() + previousBreak + 1;
  }

  const afterCaret = serializeTextblockSegment(
    parent,
    parentOffset,
    parent.content.size,
  );
  const nextBreak = afterCaret.indexOf("\n");
  return (
    $head.start() +
    (nextBreak === -1 ? parent.content.size : parentOffset + nextBreak)
  );
}

function insertPlainTextLineBreak(
  editor: Editor,
  event: KeyboardEvent,
): boolean {
  if (
    event.key !== "Enter" ||
    !event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return false;
  }

  event.preventDefault();
  return editor.commands.splitBlock();
}

// Replace the active `/query` text with the chosen token (reusing the space that
// already follows the query, or appending one). The caret is moved past that
// space so the inserted `/skill` reads as a finished token: typing the next word
// can't merge into it, and — since menu visibility is a pure function of the
// caret position — `beforeCaret` no longer ends in a live `/token`, so the menu
// closes. Without this, selecting a skill when text already follows the query
// left the caret between the token and its space, keeping the menu open. The
// decoration plugin colors the token automatically.
function insertSkillToken(
  editor: Editor,
  slashRange: SlashSkillRange,
  input: string,
  skill: ComposerSlashSkill,
): void {
  const head = editor.state.selection.head;
  const span = slashRange.end - slashRange.start;
  const from = head - span;
  const token = `/${skill.name}`;
  const suffix = input.slice(slashRange.end).startsWith(" ") ? "" : " ";
  editor
    .chain()
    .focus()
    .insertContentAt({ from, to: head }, [
      { type: "text", text: `${token}${suffix}` },
    ])
    .setTextSelection(from + token.length + 1)
    .run();
}

// Viewport position of the slash that started the active query, used to place the
// suggestion menu at the `/` the user typed instead of a fixed corner. The slash
// and caret sit on the same line (the range regex never spans a newline), so their
// distance in string offsets equals their distance in ProseMirror positions.
interface SlashCaretPosition {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

function slashCaretPosition(
  editor: Editor,
  slashRange: SlashSkillRange,
): SlashCaretPosition {
  const slashPos = Math.max(
    editor.state.selection.head - (slashRange.end - slashRange.start),
    0,
  );
  const coords = editor.view.coordsAtPos(slashPos);
  return {
    left: coords.left,
    top: coords.top,
    height: coords.bottom - coords.top,
  };
}

// Zero-size Popover anchor pinned to the active slash so the suggestion menu opens
// at the `/` the user typed rather than a fixed corner. Falls back to the viewport
// origin when there is no active slash (the menu is closed then anyway).
function SlashCaretAnchor({
  editor,
  slashRange,
}: {
  readonly editor: Editor | null;
  readonly slashRange: SlashSkillRange | null;
}) {
  const caret =
    editor && slashRange ? slashCaretPosition(editor, slashRange) : null;
  return (
    <PopoverAnchor asChild>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed"
        style={{
          left: caret?.left ?? 0,
          top: caret?.top ?? 0,
          width: 0,
          height: caret?.height ?? 0,
        }}
      />
    </PopoverAnchor>
  );
}

interface SlashMenuKeyContext {
  readonly suggestions: readonly ComposerSlashSkill[];
  readonly selectedIndex: number;
  readonly setSelectedIndex: (index: number) => void;
  readonly setCaretIndex: (index: number) => void;
  readonly onInsert: (skill: ComposerSlashSkill) => void;
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
      Math.max(ctx.suggestions.length - 1, 0),
    );
    ctx.setSelectedIndex(next);
    scrollSlashSkillIntoView(ctx.suggestions[next]);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    const next = Math.max(ctx.selectedIndex - 1, 0);
    ctx.setSelectedIndex(next);
    scrollSlashSkillIntoView(ctx.suggestions[next]);
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && ctx.suggestions[0]) {
    event.preventDefault();
    const skill =
      ctx.suggestions[Math.min(ctx.selectedIndex, ctx.suggestions.length - 1)];
    if (skill) {
      ctx.onInsert(skill);
    }
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    ctx.setCaretIndex(-1);
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
  const isLoadingOrgSkills = orgSkillsLoadable.state === "loading";
  const showSkillsPageLink = features?.[FeatureSwitchKey.SkillsViewer] ?? false;
  const showSlashSkillMenu =
    slashRange !== null &&
    (isLoadingOrgSkills || composerSkills.length > 0 || showSkillsPageLink);

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

  function handleEditorKeyDown(event: KeyboardEvent): boolean {
    // In the chat composer, Enter can be send, so Shift+Enter is the user's
    // plain-text newline. Keep it as a normal paragraph split rather than a
    // ProseMirror hardBreak so line navigation stays textarea-like.
    if (insertPlainTextLineBreak(editor, event)) {
      return true;
    }

    const lineNavigationPos = resolveMacControlLineNavigation(editor, event);
    if (lineNavigationPos !== null) {
      event.preventDefault();
      editor.commands.setTextSelection(lineNavigationPos);
      return true;
    }

    if (
      showSlashSkillMenu &&
      handleSlashMenuKey(event, {
        suggestions,
        selectedIndex: selectedSkillIndex,
        setSelectedIndex: setSelectedSkillIndex,
        setCaretIndex,
        onInsert: insertSkill,
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
    // Radix Popover (Floating UI) positions the menu cross-browser; the anchor is
    // a zero-size element pinned to the slash the user typed (viewport coords from
    // ProseMirror), so the menu opens at the `/` rather than a fixed corner. `open`
    // is fully controlled by composer state, so Escape/typing close it.
    <Popover open={showSlashSkillMenu}>
      <SlashCaretAnchor editor={editor} slashRange={slashRange} />
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
      {showSlashSkillMenu && (
        <SlashSkillMenu
          skills={suggestions}
          loading={isLoadingOrgSkills}
          selectedIndex={selectedSkillIndex}
          showSkillsPageLink={showSkillsPageLink}
          onSelect={(skill) => {
            insertSkill(skill);
          }}
        />
      )}
    </Popover>
  );
}
