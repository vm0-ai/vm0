import { cn } from "@vm0/ui";
import type { ReactNode } from "react";

const DEFAULT_CONNECTOR_HELP_TEXT_CLASS =
  "text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline";

function renderBoldConnectorHelpMarkdown(
  text: string,
  keyPrefix: string,
): ReactNode[] {
  const boldPattern = /\*\*([^*]+)\*\*/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(boldPattern)) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <strong key={`${keyPrefix}-strong-${match.index}`}>{match[1]}</strong>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderInlineConnectorHelpMarkdown(
  text: string,
  keyPrefix: string,
): ReactNode[] {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)"\s]+)\)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(linkPattern)) {
    nodes.push(
      ...renderBoldConnectorHelpMarkdown(
        text.slice(lastIndex, match.index),
        `${keyPrefix}-text-${lastIndex}`,
      ),
    );
    nodes.push(
      <a
        key={`${keyPrefix}-link-${match.index}`}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline"
      >
        {renderBoldConnectorHelpMarkdown(
          match[1],
          `${keyPrefix}-link-${match.index}-label`,
        )}
      </a>,
    );
    lastIndex = match.index + match[0].length;
  }

  nodes.push(
    ...renderBoldConnectorHelpMarkdown(
      text.slice(lastIndex),
      `${keyPrefix}-text-${lastIndex}`,
    ),
  );

  return nodes;
}

export function ConnectorHelpText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const children: ReactNode[] = [];
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    if (line.startsWith("> ")) {
      children.push(
        <div
          key={`line-${index}`}
          className="pl-3 border-l-2 border-muted text-muted-foreground"
        >
          {renderInlineConnectorHelpMarkdown(line.slice(2), `line-${index}`)}
        </div>,
      );
    } else {
      children.push(
        <span key={`line-${index}`}>
          {renderInlineConnectorHelpMarkdown(line, `line-${index}`)}
        </span>,
      );
    }
    if (index < lines.length - 1) {
      children.push("\n");
    }
  }

  return (
    <div className={cn(DEFAULT_CONNECTOR_HELP_TEXT_CLASS, className)}>
      {children}
    </div>
  );
}
