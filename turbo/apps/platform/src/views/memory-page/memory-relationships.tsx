import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  IconBuilding,
  IconClock,
  IconMail,
  IconSearch,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import type { RelationshipRecord } from "@vm0/api-contracts/contracts/zero-relationships";
import { Button, cn, Input } from "@vm0/ui";

import {
  memoryRelationshipFilter$,
  memoryRelationshipSearch$,
  memoryRelationships$,
  selectedMemoryRelationshipId$,
  setMemoryRelationshipFilter$,
  setMemoryRelationshipSearch$,
  setSelectedMemoryRelationshipId$,
  type MemoryRelationshipFilter,
} from "../../signals/memory-page/memory-signals.ts";

type RelationshipItemKind = RelationshipRecord["items"][number]["kind"];

const RELATIONSHIP_FILTERS: readonly {
  readonly value: MemoryRelationshipFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "people", label: "People" },
  { value: "organizations", label: "Organizations" },
  { value: "open-loops", label: "Open loops" },
];

function formatShortDate(value: string | null): string {
  if (!value) {
    return "No touch";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function matchesFilter(
  relationship: RelationshipRecord,
  filter: MemoryRelationshipFilter,
): boolean {
  switch (filter) {
    case "people": {
      return relationship.entity.type === "person";
    }
    case "organizations": {
      return relationship.entity.type === "organization";
    }
    case "open-loops": {
      return relationship.items.some((item) => {
        return item.kind === "open_loop";
      });
    }
    case "all": {
      return true;
    }
  }
}

function relationshipSubtitle(relationship: RelationshipRecord): string {
  const primary =
    relationship.entity.primaryEmail ?? relationship.entity.domain ?? null;
  return [primary, formatShortDate(relationship.lastInteractionAt)]
    .filter(Boolean)
    .join(" - ");
}

function relationshipItems(
  relationship: RelationshipRecord,
  kind: RelationshipItemKind,
) {
  return relationship.items.filter((item) => {
    return item.kind === kind;
  });
}

function relationshipItemCount(relationship: RelationshipRecord): number {
  return relationship.items.length;
}

function RelationshipAvatar({
  relationship,
}: {
  readonly relationship: RelationshipRecord;
}) {
  const Icon =
    relationship.entity.type === "organization" ? IconBuilding : IconUser;
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        relationship.entity.type === "organization"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-primary/10 text-primary",
      )}
      aria-hidden="true"
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function RelationshipStatusBadge({
  relationship,
}: {
  readonly relationship: RelationshipRecord;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
        relationship.status === "active"
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {relationship.status === "active" ? "Active" : "Quiet"}
    </span>
  );
}

function SourceBadge({ label }: { readonly label: string }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-border bg-background px-2 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function sourceText(item: RelationshipRecord["items"][number]): string {
  const source = item.sources[0];
  if (!source) {
    return "No source attached";
  }
  const date = formatShortDate(source.occurredAt);
  const quote = source.quote ? ` - ${source.quote}` : "";
  return `Gmail - ${date}${quote}`;
}

function RelationshipSection({
  title,
  items,
  emptyText,
}: {
  readonly title: string;
  readonly items: readonly RelationshipRecord["items"][number][];
  readonly emptyText: string;
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-background p-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {items.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {items.map((item) => {
            return (
              <div key={item.id} className="border-l-2 border-border pl-3">
                <p className="text-sm leading-5 text-foreground">{item.text}</p>
                <p className="mt-1 text-xs leading-4 text-muted-foreground">
                  {sourceText(item)}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          {emptyText}
        </p>
      )}
    </section>
  );
}

function RelationshipInteractions({
  interactions,
}: {
  readonly interactions: RelationshipRecord["recentInteractions"];
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-background p-3">
      <h3 className="text-sm font-semibold text-foreground">
        Recent interactions
      </h3>
      {interactions.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {interactions.map((interaction) => {
            return (
              <div
                key={interaction.id}
                className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"
              >
                <span className="text-xs leading-5 text-muted-foreground">
                  {formatShortDate(interaction.occurredAt)}
                </span>
                <p className="min-w-0 text-sm leading-5 text-foreground">
                  {interaction.snippet}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          No interactions yet
        </p>
      )}
    </section>
  );
}

function RelationshipDetail({
  relationship,
}: {
  readonly relationship: RelationshipRecord | null;
}) {
  if (relationship === null) {
    return (
      <section className="flex min-h-[360px] min-w-0 flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium text-foreground">
          No relationships found
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Try another name, company, email, or open loop.
        </p>
      </section>
    );
  }

  const keyFacts = relationshipItems(relationship, "key_fact");
  const preferences = relationshipItems(relationship, "preference");
  const openLoops = relationshipItems(relationship, "open_loop");

  return (
    <section className="min-w-0 bg-background">
      <header className="flex min-w-0 flex-col gap-4 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <RelationshipAvatar relationship={relationship} />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold leading-6 text-foreground">
                {relationship.entity.displayName}
              </h2>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {relationship.relationshipType} - last touch{" "}
                {formatShortDate(relationship.lastInteractionAt)}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <RelationshipStatusBadge relationship={relationship} />
            <SourceBadge label="Gmail" />
            <SourceBadge label="This org only" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            disabled
          >
            <IconMail className="h-3.5 w-3.5" />
            <span>View sources</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            disabled
          >
            <IconTrash className="h-3.5 w-3.5" />
            <span>Forget</span>
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <section className="rounded-lg border border-border/70 bg-muted/20 p-3">
          <h3 className="text-sm font-semibold text-foreground">Summary</h3>
          <p className="mt-2 text-sm leading-6 text-foreground">
            {relationship.summary || "No summary yet"}
          </p>
        </section>
        <div className="grid gap-3 md:grid-cols-2">
          <RelationshipSection
            title="Key facts"
            items={keyFacts}
            emptyText="No key facts yet"
          />
          <RelationshipSection
            title="Open loops"
            items={openLoops}
            emptyText="No open loops"
          />
        </div>
        <RelationshipSection
          title="Preferences"
          items={preferences}
          emptyText="No preferences yet"
        />
        <RelationshipInteractions
          interactions={relationship.recentInteractions}
        />
      </div>
    </section>
  );
}

function MemoryRelationshipsSkeleton() {
  return (
    <section className="zero-card flex min-h-[420px] min-w-0 items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Loading relationships
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulling relationship memory for this organization.
        </p>
      </div>
    </section>
  );
}

function MemoryRelationshipsError() {
  return (
    <section className="zero-card flex min-h-[420px] min-w-0 items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Relationships unavailable
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Try again once relationship memory is enabled.
        </p>
      </div>
    </section>
  );
}

function RelationshipsToolbar({
  search,
  filter,
  setSearch,
  setFilter,
}: {
  readonly search: string;
  readonly filter: MemoryRelationshipFilter;
  readonly setSearch: (value: string) => void;
  readonly setFilter: (value: MemoryRelationshipFilter) => void;
}) {
  return (
    <div className="border-b border-border/70 p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative min-w-0 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            placeholder="Search people, companies, emails, or open loops"
            className="h-9 pl-9 text-sm"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {RELATIONSHIP_FILTERS.map((option) => {
            const selected = option.value === filter;
            return (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "h-8 rounded-md px-2.5 text-xs font-medium transition-colors",
                  selected
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                )}
                onClick={() => {
                  setFilter(option.value);
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RelationshipList({
  relationships,
  selectedRelationship,
  setSelectedId,
}: {
  readonly relationships: readonly RelationshipRecord[];
  readonly selectedRelationship: RelationshipRecord | null;
  readonly setSelectedId: (value: string) => void;
}) {
  return (
    <aside className="min-w-0 border-b border-border/70 bg-muted/20 lg:border-b-0 lg:border-r">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Relationships
        </span>
        <span className="text-xs text-muted-foreground">
          {relationships.length}
        </span>
      </div>
      <div className="max-h-[360px] overflow-auto p-2 lg:max-h-none">
        {relationships.length > 0 ? (
          <div className="flex flex-col gap-1">
            {relationships.map((relationship) => {
              const selected = relationship.id === selectedRelationship?.id;
              return (
                <button
                  key={relationship.id}
                  type="button"
                  aria-pressed={selected}
                  className={cn(
                    "flex min-w-0 gap-3 rounded-md px-2 py-2 text-left transition-colors",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-foreground hover:bg-background/80",
                  )}
                  onClick={() => {
                    setSelectedId(relationship.id);
                  }}
                >
                  <RelationshipAvatar relationship={relationship} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {relationship.entity.displayName}
                      </span>
                      {relationship.items.some((item) => {
                        return item.kind === "open_loop";
                      }) ? (
                        <IconClock className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">
                      {relationship.relationshipType}
                    </span>
                    <span className="block truncate text-xs leading-5 text-muted-foreground">
                      {relationshipSubtitle(relationship)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs leading-5 text-muted-foreground">
                    {relationshipItemCount(relationship)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-[220px] items-center justify-center px-4 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">
                No relationships found
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Try another search or filter.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

export function MemoryRelationships() {
  const search = useGet(memoryRelationshipSearch$);
  const filter = useGet(memoryRelationshipFilter$);
  const selectedId = useGet(selectedMemoryRelationshipId$);
  const setSearch = useSet(setMemoryRelationshipSearch$);
  const setFilter = useSet(setMemoryRelationshipFilter$);
  const setSelectedId = useSet(setSelectedMemoryRelationshipId$);
  const relationshipsLoadable = useLoadable(memoryRelationships$);

  if (relationshipsLoadable.state === "loading") {
    return <MemoryRelationshipsSkeleton />;
  }
  if (relationshipsLoadable.state === "hasError") {
    return <MemoryRelationshipsError />;
  }

  const relationships = relationshipsLoadable.data.relationships.filter(
    (relationship) => {
      return matchesFilter(relationship, filter);
    },
  );
  const selectedRelationship =
    relationships.find((relationship) => {
      return relationship.id === selectedId;
    }) ??
    relationships[0] ??
    null;

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <RelationshipsToolbar
        search={search}
        filter={filter}
        setSearch={setSearch}
        setFilter={setFilter}
      />

      <div className="grid min-h-[420px] min-w-0 lg:grid-cols-[320px_minmax(0,1fr)]">
        <RelationshipList
          relationships={relationships}
          selectedRelationship={selectedRelationship}
          setSelectedId={setSelectedId}
        />

        <RelationshipDetail relationship={selectedRelationship} />
      </div>
    </section>
  );
}
