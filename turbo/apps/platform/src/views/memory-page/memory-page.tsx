import { useGet, useLoadable, useSet } from "ccstate-react";
import type { MouseEvent } from "react";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { MemoryDetailResponse } from "@vm0/api-contracts/contracts/zero-memory";
import { cn } from "@vm0/ui";

import {
  memoryDetail$,
  selectedMemoryFilePath$,
  setSelectedMemoryFilePath$,
} from "../../signals/memory-page/memory-signals.ts";
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

export function MemoryPage() {
  const detailLoadable = useLoadable(memoryDetail$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const loading = detailLoadable.state === "loading" && !detail;
  const errored = detailLoadable.state === "hasError";
  const hasFiles = detail !== null && detail.exists && detail.files.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Memory
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              What Zero remembers across runs. Read-only.
            </p>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col">
          {loading ? (
            <MemorySkeleton />
          ) : hasFiles && detail ? (
            <MemoryViewer detail={detail} />
          ) : (
            <MemoryEmptyState errored={errored} />
          )}
        </div>
      </main>
    </div>
  );
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
    <section className="zero-card flex min-h-[420px] flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Content (left) — scrolls independently of the file panel. */}
        <div className="order-1 flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-4 text-xs font-medium text-muted-foreground">
            <span className="truncate">
              {selectedPath ?? "No file selected"}
            </span>
          </div>
          {selectedPath && selectedContent !== null ? (
            selectedMarkdown !== null ? (
              <div
                aria-label="Memory content"
                className="min-h-0 flex-1 overflow-auto bg-background px-4 py-3"
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

function MemorySkeleton() {
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
