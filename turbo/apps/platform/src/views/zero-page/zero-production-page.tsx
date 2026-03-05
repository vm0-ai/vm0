import { useState } from "react";
import {
  IconSearch,
  IconFolder,
  IconUsers,
  IconUser,
  IconLayoutList,
  IconLayoutGrid,
  IconDownload,
  IconTrash,
  IconDotsVertical,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Tabs,
  TabsList,
  TabsTrigger,
  Input,
  cn,
} from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { Markdown } from "../components/markdown.tsx";

type DocScope = "all" | "team" | "personal";
type DocType = "markdown" | "pdf" | "html" | "react-app";

interface DocItem {
  id: string;
  title: string;
  type: DocType;
  scope: DocScope;
  createdBy: string;
  size: string;
  created: string;
  /** Rich-text preview (Markdown) for gallery view */
  contentPreview: string;
}

const DOCS: DocItem[] = [
  {
    id: "1",
    title: "Team Weekly Report - Week 8",
    type: "markdown",
    scope: "team",
    createdBy: "Zero Agent",
    size: "24 KB",
    created: "March 2, 2026",
    contentPreview: `**Summary** — Team activity and deliverables.

- 3 PRs merged this week; design review completed for the new dashboard. The calendar connector is in QA; we expect sign-off by Friday.
- Pending: QA sign-off on the calendar connector, docs update for API v2. The engineering team has drafted the migration guide and will publish once tests are green.
- Next week we focus on the schedule tool rollout and gathering feedback from early adopters.`,
  },
  {
    id: "2",
    title: "Product Requirements Document.pdf",
    type: "pdf",
    scope: "personal",
    createdBy: "John Smith",
    size: "1.2 MB",
    created: "March 1, 2026",
    contentPreview: `**Google Calendar connector scope**

- **Searching events:** filter by calendar ID, time range, and free-text search. Results can be limited to a configurable page size. Supports recurring event expansion.
- **Creating events:** customizable summary (title), description, start and end times, timezone, and attendee list. Supports workflow automation and templates.
- **Updates and cancellation:** full CRUD for events. Webhook support for real-time sync with external systems.`,
  },
  {
    id: "3",
    title: "Data Analysis Report",
    type: "html",
    scope: "team",
    createdBy: "Zero Agent",
    size: "156 KB",
    created: "February 28, 2026",
    contentPreview: `Usage and performance metrics for the last 30 days.

| Metric        | Value   |
|---------------|---------|
| Daily runs    | 1.2k    |
| Top tool      | search_events |
| P95 latency   | 340ms   |

Recommendations for optimizing cron-based schedules and reducing cold starts. We suggest batching small jobs and using the interval type for high-frequency tasks.`,
  },
  {
    id: "4",
    title: "Meeting Minutes",
    type: "markdown",
    scope: "team",
    createdBy: "Zero Agent",
    size: "89 KB",
    created: "February 27, 2026",
    contentPreview: `**Decisions**
- Adopt 6-field cron for schedule tool; support \`cron\` and \`interval\` types. Product will document the cron expression format and provide examples.
- Action items: document schedule setup flow, add examples for "remind me at 9 AM" and "every 30 minutes". Engineering to add validation and error messages for invalid expressions.`,
  },
  {
    id: "5",
    title: "Dashboard Demo",
    type: "react-app",
    scope: "personal",
    createdBy: "Jane Doe",
    size: "12 KB",
    created: "February 26, 2026",
    contentPreview: `**Interactive demo** of the production dashboard.

- Document gallery with list/gallery toggle. Each card shows icon, title, and a rich-text preview; the content area uses a serif font and a bottom fade.
- Search and scope filters (All / Team / Personal). Results update in real time. You can switch between grid and list layout without losing the current filter.`,
  },
  {
    id: "6",
    title: "Project Brief",
    type: "html",
    scope: "personal",
    createdBy: "Mike Johnson",
    size: "8 KB",
    created: "February 25, 2026",
    contentPreview: `**Phases**
1. Connector discovery and tool listing. Integrate with the MCP registry and support custom endpoints.
2. Run flows (search, create, schedule). Add a run history view and export for audit.
3. Reporting and export. Dashboards for usage and cost; API for programmatic access.

*Dependencies:* MCP server config, calendar API keys, and approval from security for external OAuth.`,
  },
];

const DOC_TYPE_ICON: Record<DocType, string> = {
  pdf: "/doc-types/PDF.svg",
  markdown: "/doc-types/DOC.svg",
  html: "/doc-types/DOC.svg",
  "react-app": "/doc-types/DOC.svg",
};

function DocCard({ doc }: { doc: DocItem }) {
  return (
    <Card className="group rounded-2xl border border-border/70 bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden flex flex-col h-full min-h-0">
      <CardContent className="p-5 pt-5 pb-0 flex flex-col flex-1 min-h-0">
        <div className="relative flex items-center gap-2 shrink-0 pr-0">
          <div className="shrink-0 flex items-center justify-center">
            <img
              src={DOC_TYPE_ICON[doc.type]}
              alt=""
              className="h-[22px] w-[22px] object-contain opacity-80"
              aria-hidden
            />
          </div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground leading-snug min-w-0 truncate flex-1">
            {doc.title}
          </h2>
          <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded-md bg-card/95 py-1 pl-2 pr-1 shadow-sm opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Download"
            >
              <IconDownload size={14} stroke={1.5} />
              Download
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
              aria-label="Delete"
            >
              <IconTrash size={14} stroke={1.5} />
              Delete
            </button>
          </div>
        </div>
        <div className="zero-doc-card-content relative mt-4 -mx-5 flex-1 min-h-0 overflow-hidden rounded-b-2xl border-t border-border/50 bg-muted/30 px-4 py-3">
          <div className="h-full overflow-auto">
            <Markdown
              source={doc.contentPreview}
              className="min-h-full !text-xs text-muted-foreground [&_*]:!text-inherit [&_*]:!font-inherit [&_ul]:!my-1 [&_ol]:!my-1 [&_p]:!my-1 [&_table]:!text-[11px]"
            />
          </div>
          <div
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-muted/90 to-transparent"
            aria-hidden
          />
        </div>
      </CardContent>
    </Card>
  );
}

const DOC_LIST_GRID =
  "grid grid-cols-[1fr_8rem_5rem_8rem_2.5rem] gap-x-6 items-center";

function DocListRow({ doc }: { doc: DocItem }) {
  return (
    <div className="group py-3 transition-colors hover:bg-muted/20">
      <div className={DOC_LIST_GRID}>
        <div className="flex items-center gap-3 min-w-0 pl-4">
          <div className="shrink-0 flex items-center justify-center text-muted-foreground">
            <img
              src={DOC_TYPE_ICON[doc.type]}
              alt=""
              className="h-[22px] w-[22px] object-contain"
              aria-hidden
            />
          </div>
          <span className="text-sm text-foreground truncate min-w-0">
            {doc.title}
          </span>
        </div>
        <div className="text-left text-sm text-muted-foreground">
          {doc.created}
        </div>
        <div className="text-left text-sm text-muted-foreground tabular-nums">
          {doc.size}
        </div>
        <div className="text-left text-sm text-muted-foreground truncate min-w-0">
          {doc.createdBy}
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
              >
                <IconDownload size={14} stroke={1.5} />
                Download
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <IconTrash size={14} stroke={1.5} />
                Delete
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

type ViewMode = "list" | "gallery";

export function ZeroProductionPage() {
  const [filter, setFilter] = useState<DocScope>("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("gallery");

  const filteredDocs = DOCS.filter((doc) => {
    const matchScope = filter === "all" || doc.scope === filter;
    const matchSearch =
      !search.trim() ||
      doc.title.toLowerCase().includes(search.trim().toLowerCase()) ||
      doc.createdBy.toLowerCase().includes(search.trim().toLowerCase());
    return matchScope && matchSearch;
  });

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Documents
            </h1>
            <p className="text-sm text-muted-foreground">
              Files and content created by Zero.
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
                className="pl-9 h-9 rounded-lg bg-muted/40 border-border/70"
              />
            </div>
            <div className="flex items-center gap-2">
              <Tabs
                value={filter}
                onValueChange={(v) => setFilter(v as DocScope)}
                className="w-full sm:w-auto"
              >
                <TabsList className="h-9 w-full sm:w-auto gap-1 bg-muted/60 px-1 py-1">
                  <TabsTrigger
                    value="all"
                    className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                  >
                    <IconFolder size={14} stroke={1.5} />
                    All
                  </TabsTrigger>
                  <TabsTrigger
                    value="team"
                    className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                  >
                    <IconUsers size={14} stroke={1.5} />
                    Team
                  </TabsTrigger>
                  <TabsTrigger
                    value="personal"
                    className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                  >
                    <IconUser size={14} stroke={1.5} />
                    Personal
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex h-9 rounded-lg border border-border/70 bg-muted/60 p-0.5 gap-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={cn(
                    "inline-flex h-8 items-center justify-center rounded-md px-2.5 transition-colors",
                    viewMode === "list"
                      ? "bg-background shadow-sm text-foreground"
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
                      ? "bg-background shadow-sm text-foreground"
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
          {viewMode === "gallery" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredDocs.map((doc) => (
                <DocCard key={doc.id} doc={doc} />
              ))}
            </div>
          ) : (
            <>
              {filteredDocs.length > 0 && (
                <div
                  className={cn(
                    DOC_LIST_GRID,
                    "py-2 pb-1.5 border-b border-divider text-sm font-medium text-muted-foreground",
                  )}
                >
                  <div className="text-left pl-4">Name</div>
                  <div className="text-left">Last modified</div>
                  <div className="text-left">Size</div>
                  <div className="text-left">Created by</div>
                  <div />
                </div>
              )}
              {filteredDocs.map((doc) => (
                <DocListRow key={doc.id} doc={doc} />
              ))}
            </>
          )}
          {filteredDocs.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No documents match your search.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
