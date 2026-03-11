import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconLayoutList,
  IconLayoutGrid,
  IconDownload,
  IconDotsVertical,
  IconFileText,
} from "@tabler/icons-react";
import { Card, CardContent, Input, cn } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { toast } from "@vm0/ui/components/ui/sonner";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  type ArtifactItem,
  zeroArtifacts$,
  zeroArtifactsLoading$,
  zeroArtifactsError$,
  fetchZeroArtifacts$,
  downloadArtifact$,
} from "../../signals/zero-page/zero-production.ts";
import { detach, Reason } from "../../signals/utils.ts";

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getDocIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "/doc-types/PDF.svg";
  }
  return "/doc-types/DOC.svg";
}

// ---------------------------------------------------------------------------
// Gallery card
// ---------------------------------------------------------------------------

function DocCard({
  doc,
  onDownload,
}: {
  doc: ArtifactItem;
  onDownload: () => void;
}) {
  return (
    <Card className="zero-doc-card zero-card group overflow-hidden flex flex-col h-full min-h-0">
      <CardContent className="p-5 pt-5 pb-0 flex flex-col flex-1 min-h-0">
        <div className="relative flex items-center gap-2 shrink-0 pr-0">
          <div className="shrink-0 flex items-center justify-center">
            <img
              src={getDocIcon(doc.name)}
              alt=""
              className="h-[22px] w-[22px] object-contain opacity-80"
              aria-hidden
            />
          </div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground leading-snug min-w-0 truncate flex-1">
            {doc.name}
          </h2>
          <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded-md bg-card/95 py-1 pl-2 pr-1 shadow-sm opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Download"
              onClick={onDownload}
            >
              <IconDownload size={14} stroke={1.5} />
              Download
            </button>
          </div>
        </div>
        <div className="zero-doc-card-content relative mt-4 -mx-5 flex-1 min-h-0 overflow-hidden rounded-b-2xl border-t px-4 py-3">
          <div className="zero-doc-card-fade h-full flex flex-col items-center justify-center gap-2 text-muted-foreground/50">
            <IconFileText size={32} stroke={1} />
            <span className="text-xs">{formatSize(doc.size)}</span>
            <span className="text-xs">
              {doc.fileCount} {doc.fileCount === 1 ? "file" : "files"}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

const DOC_LIST_GRID =
  "grid grid-cols-[1fr_8rem_5rem_2.5rem] gap-x-6 items-center";

function DocListRow({
  doc,
  onDownload,
}: {
  doc: ArtifactItem;
  onDownload: () => void;
}) {
  return (
    <div className="group py-3 transition-colors hover:bg-muted/20">
      <div className={DOC_LIST_GRID}>
        <div className="flex items-center gap-3 min-w-0 pl-4">
          <div className="shrink-0 flex items-center justify-center text-muted-foreground">
            <img
              src={getDocIcon(doc.name)}
              alt=""
              className="h-[22px] w-[22px] object-contain"
              aria-hidden
            />
          </div>
          <span className="text-sm text-foreground truncate min-w-0">
            {doc.name}
          </span>
        </div>
        <div className="text-left text-sm text-muted-foreground">
          {formatDate(doc.updatedAt)}
        </div>
        <div className="text-left text-sm text-muted-foreground tabular-nums">
          {formatSize(doc.size)}
        </div>
        <div>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted/80 hover:text-foreground transition-all focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label="Options"
              >
                <IconDotsVertical size={14} stroke={1.5} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="flex flex-col gap-0.5 w-40 p-2"
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onDownload}
              >
                <IconDownload size={14} stroke={1.5} />
                Download
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }, (_, i) => (
        <Card key={i} className="zero-card overflow-hidden">
          <CardContent className="p-5 animate-pulse">
            <div className="flex items-center gap-2">
              <div className="h-[22px] w-[22px] rounded bg-muted/50" />
              <div className="h-4 flex-1 rounded bg-muted/50" />
            </div>
            <div className="mt-4 h-24 rounded bg-muted/30" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type ViewMode = "list" | "gallery";

export function ZeroProductionPage() {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const search$ = useCCState("");
  const search = useGet(search$);
  const setSearch = useSet(search$);
  const viewMode$ = useCCState<ViewMode>("gallery");
  const viewMode = useGet(viewMode$);
  const setViewMode = useSet(viewMode$);

  const artifacts = useGet(zeroArtifacts$);
  const loading = useGet(zeroArtifactsLoading$);
  const error = useGet(zeroArtifactsError$);
  const fetchArtifacts = useSet(fetchZeroArtifacts$);
  const download = useSet(downloadArtifact$);

  // Fetch on mount
  const fetched$ = useCCState(false);
  const fetched = useGet(fetched$);
  const setFetched = useSet(fetched$);
  if (!fetched && !loading) {
    setFetched(true);
    detach(fetchArtifacts(), Reason.DomCallback);
  }

  const filteredDocs = artifacts.filter((doc) => {
    if (!search.trim()) {
      return true;
    }
    return doc.name.toLowerCase().includes(search.trim().toLowerCase());
  });

  const handleDownload = (name: string) => {
    detach(
      download({ name }).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Download failed");
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Documents
            </h1>
            <p className="text-sm text-muted-foreground">
              Files and content created by {agentName}.
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="relative flex-1">
              <IconSearch
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                size={16}
                stroke={1.5}
              />
              <Input
                placeholder="Search documents..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="zero-search-input pl-9 h-9 rounded-lg border"
              />
            </div>
            <div className="flex items-center gap-2">
              <div className="zero-view-toggle flex h-9 rounded-lg border p-0.5 gap-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={cn(
                    "inline-flex h-8 items-center justify-center rounded-md px-2.5 transition-colors",
                    viewMode === "list"
                      ? "zero-view-toggle-selected text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-label="List view"
                >
                  <IconLayoutList size={16} stroke={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("gallery")}
                  className={cn(
                    "inline-flex h-8 items-center justify-center rounded-md px-2.5 transition-colors",
                    viewMode === "gallery"
                      ? "zero-view-toggle-selected text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-label="Gallery view"
                >
                  <IconLayoutGrid size={16} stroke={1.5} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          {loading ? (
            <GallerySkeleton />
          ) : error ? (
            <p className="text-sm text-destructive py-8 text-center">{error}</p>
          ) : filteredDocs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <IconFileText size={32} stroke={1.2} className="opacity-50" />
              <p className="text-sm">
                {artifacts.length === 0
                  ? "No documents yet."
                  : "No documents match your search."}
              </p>
            </div>
          ) : viewMode === "gallery" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredDocs.map((doc) => (
                <DocCard
                  key={doc.name}
                  doc={doc}
                  onDownload={() => handleDownload(doc.name)}
                />
              ))}
            </div>
          ) : (
            <>
              <div
                className={cn(
                  DOC_LIST_GRID,
                  "py-2 pb-1.5 border-b border-divider text-sm font-medium text-muted-foreground",
                )}
              >
                <div className="text-left pl-4">Name</div>
                <div className="text-left">Last modified</div>
                <div className="text-left">Size</div>
                <div />
              </div>
              {filteredDocs.map((doc) => (
                <DocListRow
                  key={doc.name}
                  doc={doc}
                  onDownload={() => handleDownload(doc.name)}
                />
              ))}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
