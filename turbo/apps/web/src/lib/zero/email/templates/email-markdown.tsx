import type { CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface EmailMarkdownProps {
  children: string;
}

export function EmailMarkdown({ children }: EmailMarkdownProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}

const components = {
  p({ children }) {
    return <p style={paragraphStyle}>{children}</p>;
  },
  h1({ children }) {
    return <h1 style={h1Style}>{children}</h1>;
  },
  h2({ children }) {
    return <h2 style={h2Style}>{children}</h2>;
  },
  h3({ children }) {
    return <h3 style={h3Style}>{children}</h3>;
  },
  a({ href, title, children }) {
    return (
      <a
        href={href}
        title={title}
        target="_blank"
        rel="noreferrer"
        style={linkStyle}
      >
        {children}
      </a>
    );
  },
  strong({ children }) {
    return <strong style={boldStyle}>{children}</strong>;
  },
  em({ children }) {
    return <em style={italicStyle}>{children}</em>;
  },
  code({ children }) {
    return <code style={codeInlineStyle}>{children}</code>;
  },
  pre({ children }) {
    return <pre style={codeBlockStyle}>{children}</pre>;
  },
  blockquote({ children }) {
    return <blockquote style={blockQuoteStyle}>{children}</blockquote>;
  },
  ul({ children }) {
    return <ul style={listStyle}>{children}</ul>;
  },
  ol({ start, children }) {
    return (
      <ol start={start} style={listStyle}>
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li style={listItemStyle}>{children}</li>;
  },
  hr() {
    return <hr style={ruleStyle} />;
  },
} satisfies Components;

const fontFamily = "Arial, Helvetica, sans-serif";

const paragraphStyle = {
  margin: "0 0 10px",
  lineHeight: "1.5",
  fontSize: "14px",
  color: "#222222",
  fontFamily,
} satisfies CSSProperties;

const headerBaseStyle = {
  fontWeight: "bold",
  color: "#222222",
  fontFamily,
} satisfies CSSProperties;

const h1Style = {
  ...headerBaseStyle,
  fontSize: "18px",
  margin: "16px 0 8px",
} satisfies CSSProperties;

const h2Style = {
  ...headerBaseStyle,
  fontSize: "16px",
  margin: "14px 0 6px",
} satisfies CSSProperties;

const h3Style = {
  ...headerBaseStyle,
  fontSize: "15px",
  margin: "12px 0 4px",
} satisfies CSSProperties;

const linkStyle = {
  color: "#1a73e8",
  textDecoration: "underline",
} satisfies CSSProperties;

const boldStyle = {
  fontWeight: "bold",
} satisfies CSSProperties;

const italicStyle = {
  fontStyle: "italic",
} satisfies CSSProperties;

const codeInlineStyle = {
  fontFamily: "monospace",
  fontSize: "13px",
  backgroundColor: "#f1f3f4",
  padding: "1px 4px",
  borderRadius: "3px",
} satisfies CSSProperties;

const codeBlockStyle = {
  ...codeInlineStyle,
  display: "block",
  padding: "12px",
  borderRadius: "4px",
  overflowX: "auto",
  lineHeight: "1.4",
  whiteSpace: "pre-wrap",
} satisfies CSSProperties;

const blockQuoteStyle = {
  borderLeft: "3px solid #dadce0",
  margin: "8px 0",
  paddingLeft: "12px",
  color: "#5f6368",
} satisfies CSSProperties;

const listStyle = {
  margin: "0 0 10px",
  paddingLeft: "24px",
} satisfies CSSProperties;

const listItemStyle = {
  margin: "2px 0",
} satisfies CSSProperties;

const ruleStyle = {
  borderColor: "#dadce0",
  margin: "16px 0",
} satisfies CSSProperties;
