import { useGet, useLoadable, useSet } from "ccstate-react";
import { IconLoader2, IconSearch } from "@tabler/icons-react";
import type {
  MemoryRecallItem,
  MemoryRecallItemKind,
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
  memoryRecallKindFilter$,
  memoryRecallLimit$,
  memoryRecallQuery$,
  memoryRecallResults$,
  setMemoryRecallKindFilter$,
  setMemoryRecallLimit$,
  setMemoryRecallQuery$,
  submitMemoryRecall$,
  submittedMemoryRecallQuery$,
  type MemoryRecallKindFilter,
} from "../../signals/memory-page/memory-signals.ts";

const KIND_FILTERS: readonly {
  readonly value: MemoryRecallKindFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All kinds" },
  { value: "preference", label: "Preferences" },
  { value: "open_loop", label: "Open loops" },
  { value: "key_fact", label: "Key facts" },
];

const LIMIT_OPTIONS = [5, 10, 20, 25] as const;

function formatShortDate(value: string | null): string {
  if (!value) {
    return "No date";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function kindLabel(kind: MemoryRecallItemKind): string {
  switch (kind) {
    case "key_fact": {
      return "Key fact";
    }
    case "open_loop": {
      return "Open loop";
    }
    case "preference": {
      return "Preference";
    }
  }
}

function sourceLabel(source: MemoryRecallItem["sources"][number]): string {
  const provider = source.provider === "slack" ? "Slack" : "Gmail";
  return `${provider} - ${formatShortDate(source.occurredAt)}`;
}

function MemoryRecallToolbar({
  kindFilter,
  limit,
  loading,
  query,
  setKindFilter,
  setLimit,
  setQuery,
  submit,
}: {
  readonly kindFilter: MemoryRecallKindFilter;
  readonly limit: number;
  readonly loading: boolean;
  readonly query: string;
  readonly setKindFilter: (value: MemoryRecallKindFilter) => void;
  readonly setLimit: (value: number) => void;
  readonly setQuery: (value: string) => void;
  readonly submit: () => void;
}) {
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
            placeholder="Ask what Zero should remember"
            className="h-9 pl-9 text-sm"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select
            value={kindFilter}
            onValueChange={(value) => {
              setKindFilter(value as MemoryRecallKindFilter);
            }}
          >
            <SelectTrigger className="h-9 w-[150px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_FILTERS.map((option) => {
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
            <span>{loading ? "Recalling" : "Recall"}</span>
          </Button>
        </div>
      </div>
    </form>
  );
}

function MemoryRecallEmpty({
  submittedQuery,
}: {
  readonly submittedQuery: string;
}) {
  const hasQuery = submittedQuery.trim().length > 0;
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {hasQuery ? "No memories found" : "No recall query yet"}
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {hasQuery
            ? "Try another phrase or broaden the kind filter."
            : "Search preferences, key facts, and open loops from relationship memory."}
        </p>
      </div>
    </div>
  );
}

function MemoryRecallSkeleton() {
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">Recalling memory</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Searching structured relationship memory.
        </p>
      </div>
    </div>
  );
}

function MemoryRecallError() {
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Recall unavailable
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Try again once relationship memory is enabled.
        </p>
      </div>
    </div>
  );
}

function MemoryRecallResults({
  memories,
}: {
  readonly memories: readonly MemoryRecallItem[];
}) {
  if (memories.length === 0) {
    return <MemoryRecallEmpty submittedQuery="submitted" />;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {memories.map((memory) => {
        const firstSource = memory.sources[0] ?? null;
        return (
          <article
            key={memory.id}
            className="rounded-lg border border-border/70 bg-background p-3"
          >
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm leading-6 text-foreground">
                  {memory.text}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {kindLabel(memory.kind)} -{" "}
                  {memory.relationship.entity.displayName} - confidence{" "}
                  {memory.confidence}
                </p>
              </div>
              <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-border bg-muted/30 px-2 text-xs font-medium text-muted-foreground">
                {formatShortDate(memory.lastSeenAt)}
              </span>
            </div>

            <div className="mt-3 rounded-md bg-muted/30 px-3 py-2">
              <p className="text-xs font-medium text-foreground">
                Evidence refs
              </p>
              {firstSource ? (
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  <p>
                    {sourceLabel(firstSource)} -{" "}
                    <code className="break-all rounded bg-background px-1 py-0.5">
                      {firstSource.externalId}
                    </code>
                  </p>
                  {firstSource.quote ? (
                    <p className="mt-1 text-foreground">{firstSource.quote}</p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  No source attached
                </p>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function MemoryRecall() {
  const query = useGet(memoryRecallQuery$);
  const submittedQuery = useGet(submittedMemoryRecallQuery$);
  const kindFilter = useGet(memoryRecallKindFilter$);
  const limit = useGet(memoryRecallLimit$);
  const setQuery = useSet(setMemoryRecallQuery$);
  const setKindFilter = useSet(setMemoryRecallKindFilter$);
  const setLimit = useSet(setMemoryRecallLimit$);
  const submit = useSet(submitMemoryRecall$);
  const recallLoadable = useLoadable(memoryRecallResults$);
  const loading =
    recallLoadable.state === "loading" && submittedQuery.trim().length > 0;

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <MemoryRecallToolbar
        kindFilter={kindFilter}
        limit={limit}
        loading={loading}
        query={query}
        setKindFilter={setKindFilter}
        setLimit={setLimit}
        setQuery={setQuery}
        submit={submit}
      />

      {recallLoadable.state === "loading" ? (
        loading ? (
          <MemoryRecallSkeleton />
        ) : (
          <MemoryRecallEmpty submittedQuery={submittedQuery} />
        )
      ) : null}
      {recallLoadable.state === "hasError" ? <MemoryRecallError /> : null}
      {recallLoadable.state === "hasData" ? (
        recallLoadable.data === null ? (
          <MemoryRecallEmpty submittedQuery={submittedQuery} />
        ) : (
          <MemoryRecallResults memories={recallLoadable.data.memories} />
        )
      ) : null}
    </section>
  );
}
