import MarkdownPreview, {
  type MarkdownPreviewProps,
} from "@uiw/react-markdown-preview";

export function Markdown({ className, style, ...rest }: MarkdownPreviewProps) {
  return (
    <MarkdownPreview
      className={`!bg-transparent !text-foreground text-sm ${className ?? ""}`}
      style={{
        backgroundColor: "transparent",
        fontSize: "0.875rem",
        lineHeight: "1.5",
        fontFamily: "var(--font-family-sans)",
        ...style,
      }}
      {...rest}
    />
  );
}
