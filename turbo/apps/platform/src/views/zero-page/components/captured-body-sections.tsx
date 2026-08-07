import { IconChevronRight } from "@tabler/icons-react";
import { CopyButton } from "@vm0/ui";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import { useTranslation } from "react-i18next";
import { formatSize, InlineBadge } from "./network-badge.tsx";
import { i18n } from "../../../i18n/index.ts";
import { formatAppNumber } from "../../../i18n/format.ts";

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
      text: i18n.t(
        ($) => {
          return $.activity.network.capture.binaryData;
        },
        { size: formatSize(sizeEstimate) },
      ),
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
  const { t } = useTranslation();
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
          {truncated === true && (
            <InlineBadge color="warning">
              {t(($) => {
                return $.activity.network.capture.truncated;
              })}
            </InlineBadge>
          )}
          {truncated === false && (
            <InlineBadge color="muted">
              {t(($) => {
                return $.activity.network.capture.complete;
              })}
            </InlineBadge>
          )}
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

function HeadersSection({
  title,
  headers,
}: {
  title: string;
  headers: Record<string, string>;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(headers);
  const copyText = entries
    .map(([k, v]) => {
      return `${k}: ${v}`;
    })
    .join("\n");

  return (
    <CollapsibleSection
      title={t(
        ($) => {
          return $.activity.network.capture.headersWithCount;
        },
        { title, formattedCount: formatAppNumber(entries.length) },
      )}
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
      truncated={truncated}
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

function filterHeaders(
  raw: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!raw) {
    return null;
  }
  const filtered = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => {
      return v !== null && v !== undefined;
    }),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function BodyMetadata({
  title,
  encoding,
  truncated,
}: {
  title: string;
  encoding: NetworkLogEntry["request_body_encoding"];
  truncated: boolean | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="font-medium">{title}</span>
      {encoding && <InlineBadge color="muted">{encoding}</InlineBadge>}
      {truncated === true && (
        <InlineBadge color="warning">
          {t(($) => {
            return $.activity.network.capture.truncated;
          })}
        </InlineBadge>
      )}
      {truncated === false && (
        <InlineBadge color="muted">
          {t(($) => {
            return $.activity.network.capture.complete;
          })}
        </InlineBadge>
      )}
    </div>
  );
}

export function CapturedBodySections({ entry }: { entry: NetworkLogEntry }) {
  const { t } = useTranslation();
  const requestHeaders = filterHeaders(entry.request_headers);
  const responseHeaders = filterHeaders(entry.response_headers);
  const requestBody = entry.request_body ?? null;
  const responseBody = entry.response_body ?? null;
  const requestBodyMetadata =
    !requestBody &&
    (entry.request_body_encoding !== undefined ||
      entry.request_body_truncated !== undefined);
  const responseBodyMetadata =
    !responseBody &&
    (entry.response_body_encoding !== undefined ||
      entry.response_body_truncated !== undefined);

  if (
    !requestHeaders &&
    !responseHeaders &&
    !requestBody &&
    !responseBody &&
    !requestBodyMetadata &&
    !responseBodyMetadata
  ) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {requestHeaders && (
        <HeadersSection
          title={t(($) => {
            return $.activity.network.capture.requestHeaders;
          })}
          headers={requestHeaders}
        />
      )}
      {requestBody && (
        <BodyBlock
          title={t(($) => {
            return $.activity.network.capture.requestBody;
          })}
          body={requestBody}
          encoding={entry.request_body_encoding}
          truncated={entry.request_body_truncated}
        />
      )}
      {requestBodyMetadata && (
        <BodyMetadata
          title={t(($) => {
            return $.activity.network.capture.requestBody;
          })}
          encoding={entry.request_body_encoding}
          truncated={entry.request_body_truncated}
        />
      )}
      {responseHeaders && (
        <HeadersSection
          title={t(($) => {
            return $.activity.network.capture.responseHeaders;
          })}
          headers={responseHeaders}
        />
      )}
      {responseBody && (
        <BodyBlock
          title={t(($) => {
            return $.activity.network.capture.responseBody;
          })}
          body={responseBody}
          encoding={entry.response_body_encoding}
          truncated={entry.response_body_truncated}
        />
      )}
      {responseBodyMetadata && (
        <BodyMetadata
          title={t(($) => {
            return $.activity.network.capture.responseBody;
          })}
          encoding={entry.response_body_encoding}
          truncated={entry.response_body_truncated}
        />
      )}
    </div>
  );
}
