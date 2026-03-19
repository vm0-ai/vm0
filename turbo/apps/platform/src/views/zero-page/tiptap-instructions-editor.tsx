import { useEditor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import type { ReactNode } from "react";
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
  IconSeparator,
  IconArrowBackUp,
  IconArrowForwardUp,
} from "@tabler/icons-react";

interface TiptapInstructionsEditorProps {
  initialContent: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
}

const ICON_SIZE = 16;
const ICON_STROKE = 1.5;

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none ${active ? "bg-muted text-foreground" : ""}`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="mx-0.5 h-5 w-px bg-border" />;
}

function EditorToolbar({
  editor,
  disabled,
}: {
  editor: ReturnType<typeof useEditor>;
  disabled?: boolean;
}) {
  if (!editor) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border/60 px-2 py-1.5">
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        disabled={disabled}
        title="Bold"
      >
        <IconBold size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        disabled={disabled}
        title="Italic"
      >
        <IconItalic size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        disabled={disabled}
        title="Strikethrough"
      >
        <IconStrikethrough size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive("code")}
        disabled={disabled}
        title="Inline code"
      >
        <IconCode size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        disabled={disabled}
        title="Heading 1"
      >
        <IconH1 size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        disabled={disabled}
        title="Heading 2"
      >
        <IconH2 size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
        disabled={disabled}
        title="Heading 3"
      >
        <IconH3 size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        disabled={disabled}
        title="Bullet list"
      >
        <IconList size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        disabled={disabled}
        title="Ordered list"
      >
        <IconListNumbers size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        disabled={disabled}
        title="Blockquote"
      >
        <IconBlockquote size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        disabled={disabled}
        title="Horizontal rule"
      >
        <IconSeparator size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={disabled || !editor.can().undo()}
        title="Undo"
      >
        <IconArrowBackUp size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={disabled || !editor.can().redo()}
        title="Redo"
      >
        <IconArrowForwardUp size={ICON_SIZE} stroke={ICON_STROKE} />
      </ToolbarButton>
    </div>
  );
}

const EDITOR_CLASSES =
  "prose prose-sm max-w-none px-3 py-3 min-h-[200px] outline-none text-foreground " +
  "prose-headings:text-foreground prose-p:text-foreground prose-p:my-2 " +
  "prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base " +
  "prose-ul:my-2 prose-ol:my-2 prose-li:my-0 " +
  "prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:pl-4 prose-blockquote:text-muted-foreground " +
  "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-sm prose-code:font-mono " +
  "prose-pre:bg-muted prose-pre:rounded-md prose-pre:p-3 " +
  "prose-hr:border-border";

export function TiptapInstructionsEditor({
  initialContent,
  onChange,
  disabled = false,
}: TiptapInstructionsEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: initialContent,
    contentType: "markdown",
    editable: !disabled,
    onUpdate: ({ editor: e }) => {
      onChange(e.getMarkdown());
    },
    editorProps: {
      attributes: {
        class: EDITOR_CLASSES,
        "data-placeholder": "Write instructions for your agent...",
      },
    },
  });

  return (
    <div
      className={`rounded-lg border border-border/60 bg-transparent transition-colors focus-within:border-border ${disabled ? "opacity-60 pointer-events-none" : ""}`}
    >
      <EditorToolbar editor={editor} disabled={disabled} />
      <EditorContent editor={editor} />
    </div>
  );
}
