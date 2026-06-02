import { useGet, useLoadable, useSet } from "ccstate-react";
import type { MemoryDetailResponse } from "@vm0/api-contracts/contracts/zero-memory";
import { cn } from "@vm0/ui";

import {
  memoryDetail$,
  selectedMemoryFilePath$,
  setSelectedMemoryFilePath$,
} from "../../signals/memory-page/memory-signals.ts";
import { Markdown } from "../components/markdown.tsx";

const PREFERRED_FILE = "MEMORY.md";

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
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

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
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

  const files = [...detail.files].sort((a, b) => {
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

  return (
    <section className="zero-card min-h-[520px] overflow-hidden">
      <div className="grid min-h-[520px] gap-0 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-h-0 border-b border-border/70 bg-muted/20 lg:border-b-0 lg:border-r">
          <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
            <span className="text-xs font-medium text-muted-foreground">
              Files
            </span>
            <span className="text-xs text-muted-foreground">
              {files.length}
            </span>
          </div>
          <div className="max-h-[240px] overflow-auto p-2 lg:max-h-none">
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

        <div className="flex min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-4 text-xs font-medium text-muted-foreground">
            <span className="truncate">
              {selectedPath ?? "No file selected"}
            </span>
          </div>
          {selectedPath && selectedContent !== null ? (
            isMarkdown(selectedPath) ? (
              <div
                aria-label="Memory content"
                className="min-h-[420px] flex-1 overflow-auto bg-background px-4 py-3"
              >
                <Markdown source={selectedContent} />
              </div>
            ) : (
              <pre
                aria-label="Memory content"
                className="min-h-[420px] flex-1 overflow-auto whitespace-pre-wrap bg-background px-4 py-3 font-mono text-sm leading-6 text-foreground"
              >
                {selectedContent}
              </pre>
            )
          ) : (
            <div className="flex min-h-[420px] flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
              No content available for this file.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function MemoryEmptyState({ errored }: { readonly errored: boolean }) {
  return (
    <section className="zero-card flex min-h-[520px] flex-col items-center justify-center px-6 text-center">
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
    <section className="zero-card min-h-[520px] overflow-hidden">
      <div className="grid min-h-[520px] gap-0 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div
          className="border-b border-border/70 bg-muted/20 p-2 lg:border-b-0 lg:border-r"
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
        <div className="p-4">
          <div className="h-[420px] rounded bg-muted/50" />
        </div>
      </div>
    </section>
  );
}
