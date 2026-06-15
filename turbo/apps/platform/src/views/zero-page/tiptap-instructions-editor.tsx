// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { StarterKit } from "@tiptap/starter-kit";
import { Extension, findChildren } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Markdown } from "@tiptap/markdown";
import { common, createLowlight } from "lowlight";
import {
  IconBold,
  IconItalic,
  IconStrikethrough,
  IconH1,
  IconH2,
  IconH3,
  IconList,
  IconListNumbers,
  IconBlockquote,
  IconCode,
} from "@tabler/icons-react";
import "highlight.js/styles/github.css";

function getLowlight() {
  return createLowlight(common);
}

function flattenNodes(
  nodes: {
    properties?: { className?: string[] };
    children?: unknown[];
    value?: string;
  }[],
  className: string[] = [],
): { text: string; classes: string[] }[] {
  return nodes.flatMap((node) => {
    const classes = [...className, ...(node.properties?.className ?? [])];
    if (node.children) {
      return flattenNodes(node.children as typeof nodes, classes);
    }
    return { text: node.value ?? "", classes };
  });
}

function buildDecorations(
  doc: Parameters<typeof findChildren>[0],
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const block of findChildren(doc, (node) => {
    return node.type.name === "codeBlock";
  })) {
    let from = block.pos + 1;
    const language: string | null = block.node.attrs.language;
    const result =
      language && getLowlight().listLanguages().includes(language)
        ? getLowlight().highlight(language, block.node.textContent)
        : getLowlight().highlightAuto(block.node.textContent);

    for (const flatNode of flattenNodes(
      (result.children ?? []) as Parameters<typeof flattenNodes>[0],
    )) {
      const to = from + flatNode.text.length;
      if (flatNode.classes.length) {
        decorations.push(
          Decoration.inline(from, to, {
            class: flatNode.classes.join(" "),
          }),
        );
      }
      from = to;
    }
  }
  return DecorationSet.create(doc, decorations);
}

function createLowlightPlugin() {
  return Extension.create({
    name: "lowlightHighlight",
    addProseMirrorPlugins() {
      const pluginKey = new PluginKey("lowlight");
      return [
        new Plugin({
          key: pluginKey,
          state: {
            init(_, { doc }) {
              return buildDecorations(doc);
            },
            apply(tr, set) {
              if (tr.docChanged) {
                return buildDecorations(tr.doc);
              }
              return set.map(tr.mapping, tr.doc);
            },
          },
          props: {
            decorations(state) {
              return pluginKey.getState(state) as DecorationSet;
            },
          },
        }),
      ];
    },
  });
}

interface TiptapInstructionsEditorProps {
  initialContent: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  /** Hint shown below the editor (default copy is for agent profile instructions). */
  footerHint?: string;
}

const ICON_SIZE = 18;
const ICON_STROKE = 1.5;

function ToolbarButton({
  onAction,
  active,
  disabled,
  title,
  children,
}: {
  onAction: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onAction();
      }}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center rounded p-1.5 text-popover-foreground/70 transition-colors hover:bg-accent hover:text-popover-foreground disabled:opacity-40 disabled:pointer-events-none ${active ? "bg-accent text-popover-foreground" : ""}`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="mx-0.5 h-4 w-px bg-border" />;
}

const EDITOR_CLASSES =
  "max-w-none px-4 py-3 min-h-[200px] outline-none " +
  "text-sm text-foreground leading-relaxed font-[var(--font-family-sans)] " +
  "[&_p]:my-2 " +
  "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 " +
  "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:my-3 " +
  "[&_h3]:text-lg [&_h3]:font-medium [&_h3]:my-2 " +
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:my-2 [&_blockquote]:text-muted-foreground " +
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[13px] [&_code]:font-[var(--font-family-mono)] " +
  "[&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_hr]:border-border [&_hr]:my-4";

/**
 * Tiptap extension that captures the markdown the editor produces right after
 * parsing the initial content.  This "baseline" lets onUpdate distinguish
 * Tiptap's own round-trip normalisation from genuine user edits.
 */
function createBaselineExtension(onChange: (markdown: string) => void) {
  return Extension.create<Record<string, never>, { baseline: string | null }>({
    name: "baselineMarkdown",
    addStorage() {
      return { baseline: null };
    },
    onCreate() {
      this.storage.baseline = this.editor.getMarkdown();
    },
    onUpdate() {
      const md = this.editor.getMarkdown();
      if (md === this.storage.baseline) {
        return;
      }
      onChange(md);
    },
  });
}

export function TiptapInstructionsEditor({
  initialContent,
  onChange,
  disabled = false,
  footerHint = "Edit the instructions directly to customize your agent's behavior.",
}: TiptapInstructionsEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      createLowlightPlugin(),
      Markdown,
      createBaselineExtension(onChange),
    ],
    content: initialContent,
    contentType: "markdown",
    editable: !disabled,
    editorProps: {
      attributes: {
        class: EDITOR_CLASSES,
        "data-placeholder": "Write instructions for your agent...",
      },
    },
  });

  return (
    <div
      className={`zero-card relative transition-colors focus-within:border-primary ${disabled ? "opacity-60 pointer-events-none" : ""}`}
    >
      {editor && (
        <BubbleMenu
          editor={editor}
          updateDelay={0}
          className="z-50 flex items-center gap-1 rounded-lg zero-border bg-popover px-1.5 py-1 shadow-lg"
        >
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleBold().run();
            }}
            active={editor.isActive("bold")}
            disabled={disabled}
            title="Bold"
          >
            <IconBold size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleItalic().run();
            }}
            active={editor.isActive("italic")}
            disabled={disabled}
            title="Italic"
          >
            <IconItalic size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleStrike().run();
            }}
            active={editor.isActive("strike")}
            disabled={disabled}
            title="Strikethrough"
          >
            <IconStrikethrough size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleCode().run();
            }}
            active={editor.isActive("code")}
            disabled={disabled}
            title="Inline code"
          >
            <IconCode size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleHeading({ level: 1 }).run();
            }}
            active={editor.isActive("heading", { level: 1 })}
            disabled={disabled}
            title="Heading 1"
          >
            <IconH1 size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleHeading({ level: 2 }).run();
            }}
            active={editor.isActive("heading", { level: 2 })}
            disabled={disabled}
            title="Heading 2"
          >
            <IconH2 size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleHeading({ level: 3 }).run();
            }}
            active={editor.isActive("heading", { level: 3 })}
            disabled={disabled}
            title="Heading 3"
          >
            <IconH3 size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleBulletList().run();
            }}
            active={editor.isActive("bulletList")}
            disabled={disabled}
            title="Bullet list"
          >
            <IconList size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleOrderedList().run();
            }}
            active={editor.isActive("orderedList")}
            disabled={disabled}
            title="Ordered list"
          >
            <IconListNumbers size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleBlockquote().run();
            }}
            active={editor.isActive("blockquote")}
            disabled={disabled}
            title="Blockquote"
          >
            <IconBlockquote size={ICON_SIZE} stroke={ICON_STROKE} />
          </ToolbarButton>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      <p className="mx-4 zero-border-t pt-2 pb-3 text-xs text-muted-foreground">
        {footerHint}
      </p>
    </div>
  );
}
