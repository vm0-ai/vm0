import { useState } from "react";
import {
  IconSearch,
  IconFilter,
  IconClock,
  IconChevronRight,
} from "@tabler/icons-react";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import type { LogStatus } from "../../signals/logs-page/types.ts";
import { StatusBadge } from "../logs-page/status-badge.tsx";
import { ZeroActivityDetailPage } from "./zero-activity-detail-page.tsx";
import type {
  ActivityItem,
  ActivityStatus,
  ActivityType,
} from "./zero-activity-types.ts";

const ACTIVITIES: ActivityItem[] = [
  {
    id: "1",
    title: "Zero Agent",
    type: "zero",
    status: "success",
    duration: "2.3s",
    time: "02:56 PM",
  },
  {
    id: "2",
    title: "Code Review Reminder",
    type: "workflow",
    status: "error",
    time: "02:46 PM",
  },
  {
    id: "3",
    title: "Zero Agent",
    type: "zero",
    status: "warning",
    duration: "5.6s",
    time: "02:36 PM",
  },
  {
    id: "4",
    title: "Slack Message Sync",
    type: "workflow",
    status: "success",
    duration: "3.2s",
    time: "02:06 PM",
  },
];

const TYPE_OPTIONS: { value: "all" | ActivityType; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "zero", label: "Zero" },
  { value: "workflow", label: "Workflow" },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Status" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
];

function toLogStatus(status: ActivityStatus): LogStatus {
  const map: Record<ActivityStatus, LogStatus> = {
    success: "completed",
    error: "failed",
    warning: "timeout",
  };
  return map[status];
}

const ROW_GRID =
  "grid grid-cols-[5rem_1fr_1fr_1fr_1fr_2.5rem] gap-x-6 items-center";

function ActivityRow({
  item,
  onSelect,
}: {
  item: ActivityItem;
  onSelect: (item: ActivityItem) => void;
}) {
  const typeLabel = item.type === "zero" ? "Zero" : "Workflow";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onSelect(item);
        }
      }}
      className="py-3 rounded-r-sm transition-colors hover:bg-muted/20 cursor-pointer"
    >
      <div className={cn(ROW_GRID)}>
        <div className="text-left text-sm text-muted-foreground tabular-nums">
          {item.time}
        </div>
        <div className="min-w-0 truncate text-left text-sm text-foreground">
          {item.title}
        </div>
        <div className="text-left text-sm text-muted-foreground">
          {typeLabel}
        </div>
        <div className="text-left">
          <StatusBadge status={toLogStatus(item.status)} zeroStyle />
        </div>
        <div className="text-left text-sm text-muted-foreground tabular-nums">
          {item.duration ? (
            <span className="inline-flex items-center gap-0.5">
              <IconClock size={12} stroke={1.5} />
              {item.duration}
            </span>
          ) : (
            "—"
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(item);
            }}
            className="rounded p-1 text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors"
            aria-label="View details"
          >
            <IconChevronRight size={14} stroke={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function ZeroActivityPage() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedItem, setSelectedItem] = useState<ActivityItem | null>(null);

  const filtered = ACTIVITIES.filter((item) => {
    const matchSearch =
      !search.trim() ||
      item.title.toLowerCase().includes(search.trim().toLowerCase());
    const matchType = typeFilter === "all" || item.type === typeFilter;
    const matchStatus = statusFilter === "all" || item.status === statusFilter;
    return matchSearch && matchType && matchStatus;
  });

  if (selectedItem) {
    return (
      <ZeroActivityDetailPage
        item={selectedItem}
        onBack={() => setSelectedItem(null)}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Activity
            </h1>
            <p className="text-sm text-muted-foreground">
              Logs and runs from Zero and your workflows.
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
                placeholder="Search logs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="zero-search-input pl-9 h-9 rounded-lg border"
              />
            </div>
            <div className="flex items-center gap-3">
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-9 w-[140px] gap-2 rounded-lg bg-muted/40 border-border/70">
                  <IconFilter
                    size={14}
                    stroke={1.5}
                    className="shrink-0 text-muted-foreground"
                  />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-[140px] gap-2 rounded-lg bg-muted/40 border-border/70">
                  <IconFilter
                    size={14}
                    stroke={1.5}
                    className="shrink-0 text-muted-foreground"
                  />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-2 pb-8">
        <div className="mx-auto max-w-[900px]">
          {filtered.length > 0 && (
            <div>
              <div
                className={cn(
                  ROW_GRID,
                  "zero-activity-header py-2 pb-1.5 border-b text-sm font-medium text-muted-foreground",
                )}
              >
                <div className="text-left">Time</div>
                <div className="text-left">Title</div>
                <div className="text-left">Type</div>
                <div className="text-left">Status</div>
                <div className="text-left">Duration</div>
                <div />
              </div>
            </div>
          )}
          {filtered.map((item) => (
            <ActivityRow key={item.id} item={item} onSelect={setSelectedItem} />
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No activity matches your filters.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
