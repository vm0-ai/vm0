import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import type { MouseEvent } from "react";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { IconChevronDown, IconLoader2 } from "@tabler/icons-react";
import type { MemoryDetailResponse } from "@vm0/api-contracts/contracts/zero-memory";
import type { MemoryActivityResponse } from "@vm0/api-contracts/contracts/zero-memory-activity";
import { cn } from "@vm0/ui";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";

import {
  expandedMemoryItems$,
  loadMoreMemoryActivity$,
  memoryActivity$,
  memoryActivityExtraEntries$,
  memoryActivityExtraHasMore$,
  memoryActivityHasLoadedExtraPages$,
  memoryActivityLatestCursor$,
  memoryActivityLoadMoreError$,
  memoryActivityLoadingMore$,
  memoryDetail$,
  memoryTab$,
  selectedMemoryFilePath$,
  setMemoryTab$,
  setSelectedMemoryFilePath$,
  toggleMemoryItemExpanded$,
  type MemoryTab,
} from "../../signals/memory-page/memory-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Markdown } from "../components/markdown.tsx";

const PREFERRED_FILE = "MEMORY.md";
const LEADING_YAML_FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

interface FrontmatterField {
  readonly key: string;
  readonly value: string;
}

interface ParsedMarkdownMemory {
  readonly body: string;
  readonly frontmatter: readonly FrontmatterField[];
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function isString(value: string | null): value is string {
  return value !== null;
}

function scalarFrontmatterValueToString(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function frontmatterNodeToString(node: unknown): string | null {
  if (isScalar(node)) {
    return scalarFrontmatterValueToString(node.value);
  }
  if (isSeq(node)) {
    const items = node.items.map(frontmatterNodeToString).filter(isString);
    return items.length > 0 ? items.join(", ") : null;
  }
  return null;
}

function parseMarkdownMemory(content: string): ParsedMarkdownMemory {
  const match = content.match(LEADING_YAML_FRONTMATTER_PATTERN);
  if (!match) {
    return { body: content, frontmatter: [] };
  }

  const rawYaml = match[1] ?? "";
  const document = parseDocument(rawYaml);
  if (document.errors.length > 0) {
    return { body: content, frontmatter: [] };
  }

  if (!isMap(document.contents)) {
    return { body: content.slice(match[0].length), frontmatter: [] };
  }

  const frontmatter: FrontmatterField[] = [];
  for (const pair of document.contents.items) {
    const key = frontmatterNodeToString(pair.key);
    const renderedValue = frontmatterNodeToString(pair.value);
    if (key !== null && renderedValue !== null) {
      frontmatter.push({ key, value: renderedValue });
    }
  }

  return {
    body: content.slice(match[0].length),
    frontmatter,
  };
}

/**
 * Resolve a markdown link href to a memory file path, or null when the link
 * points outside the memory tree (absolute URL, in-page anchor, or root path).
 * Memory files reference each other with plain relative paths in MEMORY.md, so
 * we only intercept those and let the browser handle everything else.
 */
function resolveMemoryLinkPath(href: string): string | null {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("#") ||
    href.startsWith("/")
  ) {
    return null;
  }
  return href.replace(/[?#].*$/, "").replace(/^\.\//, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

interface MemoryViewerState {
  readonly files: MemoryDetailResponse["files"];
  readonly selectedPath: string | null;
  readonly selectedContent: string | null;
  readonly knownPaths: ReadonlySet<string>;
}

function deriveMemoryViewerState(
  detail: MemoryDetailResponse,
  explicitSelected: string | null,
): MemoryViewerState {
  // MEMORY.md is the index of all memory, so pin it to the top; the rest stay
  // sorted alphabetically.
  const files = [...detail.files].sort((a, b) => {
    if (a.path === PREFERRED_FILE) {
      return -1;
    }
    if (b.path === PREFERRED_FILE) {
      return 1;
    }
    return a.path.localeCompare(b.path);
  });
  const preferredPath =
    files.find((file) => {
      return file.path === PREFERRED_FILE;
    })?.path ??
    files[0]?.path ??
    null;
  const selectedPath =
    explicitSelected !== null &&
    files.some((file) => {
      return file.path === explicitSelected;
    })
      ? explicitSelected
      : preferredPath;
  const selectedContent = selectedPath
    ? (detail.fileContents.find((file) => {
        return file.path === selectedPath;
      })?.content ?? null)
    : null;
  const knownPaths = new Set(
    files.map((file) => {
      return file.path;
    }),
  );
  return { files, selectedPath, selectedContent, knownPaths };
}

function isMemoryTab(value: string): value is MemoryTab {
  return value === "updates" || value === "raw";
}

export function MemoryPage() {
  const activeTab = useGet(memoryTab$);
  const setTab = useSet(setMemoryTab$);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Memory
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              What Zero remembers from previous work.
            </p>
          </div>
          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              if (isMemoryTab(value)) {
                setTab(value);
              }
            }}
            className="mt-3"
          >
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger
                value="updates"
                className="gap-1.5 px-3 text-sm data-[state=active]:bg-background"
              >
                Updates
              </TabsTrigger>
              <TabsTrigger
                value="raw"
                className="gap-1.5 px-3 text-sm data-[state=active]:bg-background"
              >
                Memory files
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col">
          {activeTab === "updates" ? <MemoryUpdates /> : <MemoryRawFiles />}
        </div>
      </main>
    </div>
  );
}

function MemoryRawFiles() {
  const detailLoadable = useLoadable(memoryDetail$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const loading = detailLoadable.state === "loading" && !detail;
  const errored = detailLoadable.state === "hasError";
  const hasFiles = detail !== null && detail.exists && detail.files.length > 0;

  if (loading) {
    return <MemoryRawFilesSkeleton />;
  }
  if (hasFiles && detail) {
    return <MemoryViewer detail={detail} />;
  }
  return <MemoryEmptyState errored={errored} />;
}

function MemoryViewer({ detail }: { readonly detail: MemoryDetailResponse }) {
  const explicitSelected = useGet(selectedMemoryFilePath$);
  const setSelected = useSet(setSelectedMemoryFilePath$);

  const { files, selectedPath, selectedContent, knownPaths } =
    deriveMemoryViewerState(detail, explicitSelected);
  const selectedMarkdown =
    selectedPath !== null &&
    selectedContent !== null &&
    isMarkdown(selectedPath)
      ? parseMarkdownMemory(selectedContent)
      : null;

  // Links between memory files render as relative anchors (e.g.
  // `[foo](foo.md)`). Left alone they navigate the browser to a non-existent
  // route and 404, so intercept clicks that resolve to a known file and switch
  // the viewer instead. External links fall through to the browser.
  const handleContentClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const anchor = event.target.closest("a");
    if (anchor === null) {
      return;
    }
    const href = anchor.getAttribute("href");
    if (href === null) {
      return;
    }
    const targetPath = resolveMemoryLinkPath(href);
    if (targetPath === null || !knownPaths.has(targetPath)) {
      return;
    }
    event.preventDefault();
    setSelected(targetPath);
  };

  return (
    <section className="zero-card flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        {/* Content (left) — scrolls independently of the file panel. */}
        <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-4 text-xs font-medium text-muted-foreground">
            <span className="truncate">
              {selectedPath ?? "No file selected"}
            </span>
          </div>
          {selectedPath && selectedContent !== null ? (
            selectedMarkdown !== null ? (
              <div
                aria-label="Memory content"
                className="min-h-0 min-w-0 flex-1 overflow-auto bg-background px-4 py-3"
                onClick={handleContentClick}
              >
                <MemoryFrontmatter fields={selectedMarkdown.frontmatter} />
                <Markdown source={selectedMarkdown.body} />
              </div>
            ) : (
              <pre
                aria-label="Memory content"
                className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-background px-4 py-3 font-mono text-sm leading-6 text-foreground"
              >
                {selectedContent}
              </pre>
            )
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
              No content available for this file.
            </div>
          )}
        </div>

        {/* File panel (right) — fixed; its own scroll, doesn't move with content. */}
        <aside className="order-2 flex min-h-0 flex-col border-t border-border/70 bg-muted/20 lg:w-[240px] lg:shrink-0 lg:border-l lg:border-t-0">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 px-3">
            <span className="text-xs font-medium text-muted-foreground">
              Files
            </span>
            <span className="text-xs text-muted-foreground">
              {files.length}
            </span>
          </div>
          <div className="max-h-[240px] min-h-0 flex-1 overflow-auto p-2 lg:max-h-none">
            <div className="flex flex-col gap-1">
              {files.map((file) => {
                const selected = file.path === selectedPath;
                return (
                  <button
                    key={file.path}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors",
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/70",
                    )}
                    onClick={() => {
                      setSelected(file.path);
                    }}
                  >
                    <span className="min-w-0 truncate text-xs">
                      {file.path}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(file.size)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function fieldByKey(
  fields: readonly FrontmatterField[],
  keys: readonly string[],
): FrontmatterField | null {
  return (
    fields.find((field) => {
      return keys.includes(field.key);
    }) ?? null
  );
}

function MemoryFrontmatter({
  fields,
}: {
  readonly fields: readonly FrontmatterField[];
}) {
  if (fields.length === 0) {
    return null;
  }

  const title = fieldByKey(fields, ["name", "title"]);
  const description = fieldByKey(fields, ["description"]);
  const detailFields = fields.filter((field) => {
    return field !== title && field !== description;
  });
  const hasSummary = title !== null || description !== null;

  return (
    <header className="mb-4 border-b border-border/70 pb-3">
      {title ? (
        <h2 className="text-sm font-semibold leading-5 text-foreground">
          {title.value}
        </h2>
      ) : null}
      {description ? (
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {description.value}
        </p>
      ) : null}
      {detailFields.length > 0 ? (
        <dl
          className={cn(
            "flex flex-wrap gap-x-4 gap-y-1 text-xs leading-5",
            hasSummary ? "mt-2" : "",
          )}
        >
          {detailFields.map((field) => {
            return (
              <div key={field.key} className="flex min-w-0 gap-1.5">
                <dt className="shrink-0 text-muted-foreground">{field.key}</dt>
                <dd className="min-w-0 truncate font-medium text-foreground">
                  {field.value}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </header>
  );
}

type MemoryActivityEntry = MemoryActivityResponse["entries"][number];
type MemoryActivityItem = MemoryActivityEntry["items"][number];
type MemoryActivityDiff = MemoryActivityItem["diff"];
type MemoryActivityDiffLine =
  MemoryActivityDiff["hunks"][number]["lines"][number];

const DIFF_LINE_CLASS = {
  add: "border-l-emerald-500 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
  remove: "border-l-rose-500 bg-rose-500/10 text-rose-950 dark:text-rose-100",
  context: "border-l-transparent text-muted-foreground",
} as const satisfies Record<MemoryActivityDiffLine["op"], string>;

const DIFF_LINE_SYMBOL = {
  add: "+",
  remove: "-",
  context: " ",
} as const satisfies Record<MemoryActivityDiffLine["op"], string>;

/**
 * Deterministic fallback line shown when the LLM narrative is null, based only
 * on the raw file diffs persisted for the day.
 */
function buildFallbackSummary(items: readonly MemoryActivityItem[]): string {
  const totals = { added: 0, removed: 0 };
  for (const item of items) {
    totals.added += item.diff.stats.added;
    totals.removed += item.diff.stats.removed;
  }
  const total = items.length;
  if (total === 0) {
    return "No memory files changed.";
  }
  const noun = total === 1 ? "memory file" : "memory files";
  return `${total} ${noun} changed (${formatLineStatsText(totals)}).`;
}

function formatActivityDate(date: string): string {
  // `date` is a local YYYY-MM-DD label produced server-side. Parse it as a
  // local date (not UTC) so the displayed day matches the stored label exactly.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return date;
  }
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return parsed.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function hasDiffEvidence(diff: MemoryActivityDiff): boolean {
  return (
    diff.hunks.some((hunk) => {
      return hunk.lines.length > 0;
    }) || diff.omittedReason !== undefined
  );
}

function formatLineStatsText(stats: {
  readonly added: number;
  readonly removed: number;
}): string {
  const parts: string[] = [];
  if (stats.added > 0) {
    parts.push(`+${stats.added}`);
  }
  if (stats.removed > 0) {
    parts.push(`-${stats.removed}`);
  }
  return parts.length === 0 ? "0" : parts.join(" ");
}

function MemoryUpdates() {
  const activityLoadable = useLoadable(memoryActivity$);
  const extraEntries = useLastResolved(memoryActivityExtraEntries$) ?? [];
  const hasLoadedExtraPages =
    useLastResolved(memoryActivityHasLoadedExtraPages$) ?? false;
  const extraHasMore = useLastResolved(memoryActivityExtraHasMore$) ?? false;
  const latestCursor = useLastResolved(memoryActivityLatestCursor$);
  const loadingMore = useLastResolved(memoryActivityLoadingMore$) ?? false;
  const loadMoreError = useLastResolved(memoryActivityLoadMoreError$) ?? null;
  const loadMore = useSet(loadMoreMemoryActivity$);
  const pageSignal = useGet(pageSignal$);

  if (activityLoadable.state === "loading") {
    return <MemoryUpdatesSkeleton />;
  }
  if (activityLoadable.state === "hasError") {
    return <MemoryEmptyState errored />;
  }

  const entries = [...activityLoadable.data.entries, ...extraEntries];
  if (entries.length === 0) {
    return <MemoryUpdatesEmptyState />;
  }
  const cursorForLoadMore = hasLoadedExtraPages
    ? latestCursor
    : activityLoadable.data.nextCursor;
  const hasMore = hasLoadedExtraPages
    ? extraHasMore
    : activityLoadable.data.nextCursor !== null;

  function handleLoadMore() {
    if (!cursorForLoadMore || loadingMore) {
      return;
    }
    detach(loadMore(cursorForLoadMore, pageSignal), Reason.DomCallback);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-2">
      {entries.map((entry) => {
        return <MemoryUpdateCard key={entry.toVersionId} entry={entry} />;
      })}
      {hasMore ? (
        <MemoryUpdatesLoadMore
          loading={loadingMore}
          error={loadMoreError}
          onLoadMore={handleLoadMore}
        />
      ) : null}
    </div>
  );
}

function MemoryUpdatesLoadMore({
  loading,
  error,
  onLoadMore,
}: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadMore: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-2 py-1">
      <button
        type="button"
        disabled={loading}
        onClick={onLoadMore}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border/70 bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
      >
        {loading ? (
          <IconLoader2 size={14} className="animate-spin" />
        ) : (
          <IconChevronDown size={14} />
        )}
        <span>{loading ? "Loading..." : "Load more"}</span>
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function MemoryUpdateCard({ entry }: { readonly entry: MemoryActivityEntry }) {
  const summary = entry.summary ?? buildFallbackSummary(entry.items);

  return (
    <section className="zero-card flex shrink-0 flex-col overflow-hidden">
      <header className="border-b border-border/70 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          {formatActivityDate(entry.date)}
        </h2>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-muted-foreground">
          {summary}
        </p>
      </header>
      <div className="flex flex-col gap-2 px-4 py-3">
        {entry.items.map((item) => {
          const itemKey = `${entry.toVersionId}:${item.filePath}`;
          return (
            <MemoryUpdateItem key={itemKey} itemKey={itemKey} item={item} />
          );
        })}
      </div>
    </section>
  );
}

function MemoryUpdateItem({
  itemKey,
  item,
}: {
  readonly itemKey: string;
  readonly item: MemoryActivityItem;
}) {
  const expandedByKey = useGet(expandedMemoryItems$);
  const toggleExpanded = useSet(toggleMemoryItemExpanded$);
  const expanded = expandedByKey[itemKey] ?? false;
  const hasEvidence = hasDiffEvidence(item.diff);

  return (
    <div className="rounded-md border border-border/70 bg-background">
      <button
        type="button"
        aria-expanded={expanded}
        disabled={!hasEvidence}
        onClick={() => {
          toggleExpanded(itemKey);
        }}
        className={cn(
          "flex w-full min-w-0 items-center justify-between gap-3 px-3 py-2 text-left",
          hasEvidence
            ? "transition-colors hover:bg-accent/40"
            : "cursor-default",
        )}
      >
        <span className="min-w-0 truncate font-mono text-xs text-foreground">
          {item.filePath}
        </span>
        <MemoryLineStats diff={item.diff} />
      </button>
      {expanded && hasEvidence ? (
        <div className="border-t border-border/70 px-3 py-2">
          <MemoryDiffView diff={item.diff} />
        </div>
      ) : null}
    </div>
  );
}

function MemoryLineStats({ diff }: { readonly diff: MemoryActivityDiff }) {
  const { added, removed } = diff.stats;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-xs">
      {added > 0 ? (
        <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
      ) : null}
      {removed > 0 ? (
        <span className="text-rose-700 dark:text-rose-300">-{removed}</span>
      ) : null}
      {added === 0 && removed === 0 ? (
        <span className="text-muted-foreground">0</span>
      ) : null}
    </span>
  );
}

function MemoryDiffView({ diff }: { readonly diff: MemoryActivityDiff }) {
  return (
    <div
      aria-label="Memory diff"
      className="overflow-hidden rounded-md border border-border/70 bg-muted/20"
    >
      {diff.hunks.map((hunk, hunkIndex) => {
        const hunkKey = `${hunk.beforeStartLine ?? "x"}:${hunk.afterStartLine ?? "x"}:${hunkIndex}`;
        return (
          <div
            key={hunkKey}
            className={cn(hunkIndex > 0 && "border-t border-border/70")}
          >
            {hunk.lines.map((line, lineIndex) => {
              const lineKey = `${line.beforeLine ?? "x"}:${line.afterLine ?? "x"}:${line.op}:${lineIndex}`;
              return (
                <div
                  key={lineKey}
                  className={cn(
                    "grid grid-cols-[3rem_3rem_1.75rem_minmax(0,1fr)] border-l-2 font-mono text-xs leading-5",
                    DIFF_LINE_CLASS[line.op],
                  )}
                >
                  <span className="select-none px-2 text-right text-muted-foreground/70">
                    {line.beforeLine ?? ""}
                  </span>
                  <span className="select-none border-l border-border/50 px-2 text-right text-muted-foreground/70">
                    {line.afterLine ?? ""}
                  </span>
                  <span className="select-none border-l border-border/50 px-2 text-right text-muted-foreground">
                    {DIFF_LINE_SYMBOL[line.op]}
                  </span>
                  <span className="whitespace-pre-wrap break-words border-l border-border/50 py-0.5 pr-3 pl-2">
                    {line.text}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {diff.omittedReason ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Diff omitted because this memory file is too large.
        </div>
      ) : null}
      {diff.truncated && !diff.omittedReason ? (
        <div className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
          Diff truncated.
        </div>
      ) : null}
    </div>
  );
}

function MemoryUpdatesEmptyState() {
  return (
    <section className="zero-card flex min-h-[420px] flex-1 flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-foreground">No updates yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Memory-change tracking starts from when this feature launched. As your
        agents run and Zero learns, daily updates will appear here.
      </p>
    </section>
  );
}

function MemoryEmptyState({ errored }: { readonly errored: boolean }) {
  return (
    <section className="zero-card flex min-h-[420px] flex-1 flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-foreground">
        {errored ? "Couldn't load memory" : "No memory yet"}
      </p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {errored
          ? "Something went wrong loading your memory. Try again later."
          : "Zero hasn't recorded any memory yet. It builds up as your agents run and will appear here."}
      </p>
    </section>
  );
}

function MemoryUpdatesSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-2"
      data-testid="memory-updates-loading"
    >
      {[0, 1].map((cardIndex) => {
        return (
          <section
            key={cardIndex}
            className="zero-card flex shrink-0 flex-col overflow-hidden"
          >
            <header className="border-b border-border/70 px-4 py-3">
              <div className="h-4 w-40 rounded bg-muted/50" />
              <div className="mt-2 h-3 w-full max-w-[560px] rounded bg-muted/50" />
            </header>
            <div className="flex flex-col gap-2 px-4 py-3">
              {[0, 1, 2].map((itemIndex) => {
                return (
                  <div
                    key={itemIndex}
                    className="rounded-md border border-border/70 bg-background px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="h-3 w-52 max-w-full rounded bg-muted/50" />
                      <div className="h-3 w-12 shrink-0 rounded bg-muted/50" />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function MemoryRawFilesSkeleton() {
  return (
    <section className="zero-card flex min-h-[420px] flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="order-1 flex min-h-0 flex-1 flex-col p-4">
          <div className="min-h-[260px] flex-1 rounded bg-muted/50" />
        </div>
        <div
          className="order-2 border-t border-border/70 bg-muted/20 p-2 lg:w-[240px] lg:shrink-0 lg:border-l lg:border-t-0"
          data-testid="memory-loading"
        >
          <div className="flex flex-col gap-1">
            {[0, 1, 2, 3].map((index) => {
              return (
                <div key={index} className="h-7 w-full rounded bg-muted/50" />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
