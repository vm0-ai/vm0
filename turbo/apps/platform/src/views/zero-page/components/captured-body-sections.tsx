import { IconChevronRight } from "@tabler/icons-react";
import { CopyButton } from "@vm0/ui";
import type { NetworkLogEntry } from "@vm0/core";
import { formatSize, InlineBadge } from "./network-badge.tsx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBodyForDisplay(
  body: string,
  encoding: NetworkLogEntry["request_body_encoding"],
): { text: string; isBinary: boolean } {
  if (encoding === "base64") {
    const sizeEstimate = Math.round((body.length * 3) / 4);
    return {
      text: `[Binary data, ${formatSize(sizeEstimate)} base64-encoded]`,
      isBinary: true,
    };
  }
  return { text: body, isBinary: false };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  badge,
  truncated,
  copyText,
  children,
}: {
  title: string;
  badge?: string;
  truncated?: boolean;
  copyText?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none w-full text-left">
        <div className="flex items-center gap-2">
          <IconChevronRight
            size={14}
            stroke={2}
            className="transition-transform group-open:rotate-90 text-muted-foreground shrink-0"
          />
          <span className="text-xs font-medium text-foreground">{title}</span>
          {badge && <InlineBadge color="muted">{badge}</InlineBadge>}
          {truncated && <InlineBadge color="warning">truncated</InlineBadge>}
          {copyText && (
            <span
              className="ml-auto"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <CopyButton text={copyText} className="p-1" />
            </span>
          )}
        </div>
      </summary>
      <div className="mt-2 ml-5">{children}</div>
    </details>
  );
}

function RequestHeaders({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  const copyText = entries
    .map(([k, v]) => {
      return `${k}: ${v}`;
    })
    .join("\n");

  return (
    <CollapsibleSection
      title={`Request Headers (${entries.length})`}
      copyText={copyText}
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {entries.map(([name, value]) => {
          return (
            <div key={name} className="contents">
              <span className="text-muted-foreground font-medium font-mono">
                {name}
              </span>
              <span className="font-mono break-all">{value}</span>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

function BodyBlock({
  title,
  body,
  encoding,
  truncated,
}: {
  title: string;
  body: string;
  encoding: NetworkLogEntry["request_body_encoding"];
  truncated: boolean | undefined;
}) {
  const { text, isBinary } = formatBodyForDisplay(body, encoding);

  return (
    <CollapsibleSection
      title={title}
      badge={encoding}
      truncated={truncated === true}
      copyText={isBinary ? undefined : body}
    >
      <pre
        className={`rounded-md border bg-muted/50 p-3 text-xs overflow-auto max-h-60 whitespace-pre-wrap break-words font-mono ${
          isBinary ? "text-muted-foreground italic" : ""
        }`}
      >
        {text}
      </pre>
    </CollapsibleSection>
  );
}

export function CapturedBodySections({ entry }: { entry: NetworkLogEntry }) {
  const requestHeaders =
    entry.request_headers && Object.keys(entry.request_headers).length > 0
      ? entry.request_headers
      : null;
  const requestBody = entry.request_body ?? null;
  const responseBody = entry.response_body ?? null;

  if (!requestHeaders && !requestBody && !responseBody) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {requestHeaders && <RequestHeaders headers={requestHeaders} />}
      {requestBody && (
        <BodyBlock
          title="Request Body"
          body={requestBody}
          encoding={entry.request_body_encoding}
          truncated={entry.request_body_truncated}
        />
      )}
      {responseBody && (
        <BodyBlock
          title="Response Body"
          body={responseBody}
          encoding={entry.response_body_encoding}
          truncated={entry.response_body_truncated}
        />
      )}
    </div>
  );
}
