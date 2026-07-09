import { useGet, useLoadable, useSet } from "ccstate-react";
import { IconLoader2, IconSearch } from "@tabler/icons-react";
import type {
  MemorySearchMode,
  MemorySearchResult,
} from "@vm0/api-contracts/contracts/zero-memory";
import { Button, Input } from "@vm0/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";

import {
  memorySearchLimit$,
  memorySearchMode$,
  memorySearchProviderFilter$,
  memorySearchQuery$,
  memorySearchResults$,
  setMemorySearchLimit$,
  setMemorySearchMode$,
  setMemorySearchProviderFilter$,
  setMemorySearchQuery$,
  submitMemorySearch$,
  submittedMemorySearchQuery$,
  type MemorySearchProviderFilter,
} from "../../signals/memory-page/memory-signals.ts";

const MODE_OPTIONS: readonly {
  readonly value: MemorySearchMode;
  readonly label: string;
}[] = [
  { value: "hybrid", label: "Hybrid" },
  { value: "documents", label: "Documents" },
  { value: "memories", label: "Memories" },
];

const PROVIDER_OPTIONS: readonly {
  readonly value: MemorySearchProviderFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All sources" },
  { value: "github", label: "GitHub" },
  { value: "notion", label: "Notion" },
  { value: "slack", label: "Slack" },
  { value: "gmail", label: "Gmail" },
];

const LIMIT_OPTIONS = [5, 10, 20, 25] as const;

function compactText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 220
    ? `${normalized.slice(0, 217)}...`
    : normalized;
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function MemorySearchToolbar() {
  const query = useGet(memorySearchQuery$);
  const mode = useGet(memorySearchMode$);
  const provider = useGet(memorySearchProviderFilter$);
  const limit = useGet(memorySearchLimit$);
  const submittedQuery = useGet(submittedMemorySearchQuery$);
  const loadable = useLoadable(memorySearchResults$);
  const setQuery = useSet(setMemorySearchQuery$);
  const setMode = useSet(setMemorySearchMode$);
  const setProvider = useSet(setMemorySearchProviderFilter$);
  const setLimit = useSet(setMemorySearchLimit$);
  const submit = useSet(submitMemorySearch$);
  const loading =
    loadable.state === "loading" && submittedQuery.trim().length > 0;

  return (
    <form
      className="border-b border-border/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder="Search memories and source documents"
            className="h-9 pl-9 text-sm"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select
            value={mode}
            onValueChange={(value) => {
              setMode(value as MemorySearchMode);
            }}
          >
            <SelectTrigger className="h-9 w-[118px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select
            value={provider}
            onValueChange={(value) => {
              setProvider(value as MemorySearchProviderFilter);
            }}
          >
            <SelectTrigger className="h-9 w-[132px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select
            value={String(limit)}
            onValueChange={(value) => {
              setLimit(Number(value));
            }}
          >
            <SelectTrigger className="h-9 w-[96px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option} value={String(option)}>
                    {option} rows
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Button
            type="submit"
            size="sm"
            className="h-9 gap-1.5 px-3 text-sm"
            disabled={loading || query.trim().length === 0}
          >
            {loading ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconSearch className="h-4 w-4" />
            )}
            <span>{loading ? "Searching" : "Search"}</span>
          </Button>
        </div>
      </div>
    </form>
  );
}

function MemorySearchEmpty() {
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          No search results yet
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Search durable memories and raw document chunks with citations.
        </p>
      </div>
    </div>
  );
}

function SearchResultCard({ result }: { readonly result: MemorySearchResult }) {
  if (result.kind === "memory") {
    return (
      <article className="rounded-lg border border-border/70 bg-background p-3">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm leading-6 text-foreground">
              {result.memory.text}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Memory - {result.memory.kind} -{" "}
              {result.memory.relationship.entity.displayName}
            </p>
          </div>
          <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-border bg-muted/30 px-2 text-xs font-medium text-muted-foreground">
            Score {formatScore(result.score)}
          </span>
        </div>
      </article>
    );
  }

  return (
    <article className="rounded-lg border border-border/70 bg-background p-3">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-6 text-foreground">
            {result.title ?? result.externalId}
          </p>
          <p className="mt-1 text-sm leading-6 text-foreground">
            {compactText(result.text)}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Document - {result.provider}:{result.externalId} -{" "}
            {result.contextSpace.displayName}
          </p>
        </div>
        <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-border bg-muted/30 px-2 text-xs font-medium text-muted-foreground">
          Score {formatScore(result.score)}
        </span>
      </div>
      <div className="mt-3 rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
        <p className="font-medium text-foreground">Citation</p>
        <p className="break-all">
          {result.citation.title ?? result.citation.externalId}
          {result.citation.locator ? ` - ${result.citation.locator}` : ""}
        </p>
        {result.citation.url ? (
          <a
            href={result.citation.url}
            className="break-all text-foreground underline-offset-2 hover:underline"
          >
            {result.citation.url}
          </a>
        ) : null}
      </div>
    </article>
  );
}

function MemorySearchResultsList() {
  const loadable = useLoadable(memorySearchResults$);

  if (loadable.state === "loading") {
    return (
      <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm text-muted-foreground">
        <IconLoader2 className="h-4 w-4 animate-spin" />
        <span>Searching memory</span>
      </div>
    );
  }
  if (loadable.state === "hasError") {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Memory search is unavailable.
      </div>
    );
  }
  if (loadable.state !== "hasData" || loadable.data === null) {
    return <MemorySearchEmpty />;
  }
  if (loadable.data.results.length === 0) {
    return <MemorySearchEmpty />;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {loadable.data.results.map((result) => {
        return <SearchResultCard key={result.id} result={result} />;
      })}
    </div>
  );
}

export function MemorySearch() {
  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <MemorySearchToolbar />
      <MemorySearchResultsList />
    </section>
  );
}
