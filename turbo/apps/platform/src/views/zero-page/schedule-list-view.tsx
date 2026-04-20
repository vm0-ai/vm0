// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  IconPencil,
  IconTrash,
  IconPlus,
  IconPlayerPlay,
  IconDotsVertical,
} from "@tabler/icons-react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { Link } from "../router/link.tsx";
import type { ScheduleEntry } from "./schedule-utils";
import emptyScheduleImg from "./assets/empty-schedule.webp";

// ---------------------------------------------------------------------------
// Row component (extracted to stay under ESLint complexity limit)
// ---------------------------------------------------------------------------

function ScheduleListRow<T extends ScheduleEntry>({
  entry,
  toggling,
  running,
  showAgent,
  agentLabel,
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  onOpenDetails,
}: {
  entry: T;
  toggling: boolean;
  running: boolean;
  showAgent: boolean;
  agentLabel?: string;
  onEdit: (entry: T) => void;
  onToggle?: (entry: T, enabled: boolean) => void;
  onDelete?: (entry: T) => void;
  onRunNow?: (entry: T) => void;
  onOpenDetails?: (entry: T) => void;
}) {
  const dimmed = entry.enabled === false;
  const clickable = !!onOpenDetails;

  return (
    <tr
      className={cn(
        "border-b border-border/50 last:border-0 transition-colors",
        clickable && "hover:bg-muted/25 cursor-pointer",
        dimmed && "opacity-75",
      )}
      onClick={
        clickable
          ? () => {
              return onOpenDetails(entry);
            }
          : undefined
      }
    >
      {showAgent && (
        <td className="py-2.5 pr-2 align-middle w-[5rem]">
          <span className="block min-w-0 truncate text-sm font-medium text-foreground">
            {agentLabel}
          </span>
        </td>
      )}
      <td className="py-2.5 pr-4 align-middle min-w-0 max-w-[1px]">
        {clickable ? (
          <Link
            pathname="/schedules/:scheduleId"
            options={{ pathParams: { scheduleId: entry.id } }}
            aria-label={`Open schedule ${entry.prompt}`}
            onClick={(e) => {
              e.stopPropagation();
            }}
            className={cn(
              "text-sm text-foreground leading-snug block truncate whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring rounded-sm",
              dimmed && "text-muted-foreground",
            )}
          >
            {entry.description || entry.prompt}
          </Link>
        ) : (
          <span
            className={cn(
              "text-sm text-foreground leading-snug block truncate whitespace-nowrap",
              dimmed && "text-muted-foreground",
            )}
          >
            {entry.description || entry.prompt}
          </span>
        )}
      </td>
      <td
        className={cn(
          "py-2.5 px-2 align-middle text-sm text-muted-foreground min-w-[6.5rem] max-w-[9rem] overflow-hidden",
          dimmed && "text-muted-foreground/80",
        )}
      >
        <span className="block min-w-0 truncate whitespace-nowrap leading-snug tabular-nums">
          {entry.time}
          {entry.timezone && (
            <span className="text-muted-foreground/70">
              {" "}
              · {entry.timezone.replace(/_/g, " ")}
            </span>
          )}
        </span>
      </td>
      {onToggle && (
        <td
          className="py-2.5 px-3 align-middle w-16"
          onClick={(e) => {
            return e.stopPropagation();
          }}
        >
          <div className="flex justify-center">
            <LoadingSwitch
              checked={entry.enabled !== false}
              loading={toggling}
              onCheckedChange={(checked) => {
                onToggle(entry, checked);
              }}
              ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} ${entry.time}`}
            />
          </div>
        </td>
      )}
      <td
        className="py-2.5 pl-2 align-middle text-right w-10"
        onClick={(e) => {
          return e.stopPropagation();
        }}
      >
        <div className="inline-flex justify-end">
          <RowActions
            entry={entry}
            running={running}
            onEdit={onEdit}
            onDelete={onDelete}
            onRunNow={onRunNow}
          />
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Shared actions dropdown
// ---------------------------------------------------------------------------

function RowActions<T extends ScheduleEntry>({
  entry,
  running,
  onEdit,
  onDelete,
  onRunNow,
}: {
  entry: T;
  running: boolean;
  onEdit: (entry: T) => void;
  onDelete?: (entry: T) => void;
  onRunNow?: (entry: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
          aria-label={`More actions for ${entry.time}`}
        >
          <IconDotsVertical size={14} stroke={1.5} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {onRunNow && (
          <DropdownMenuItem
            disabled={running || !entry.prompt.trim()}
            className="gap-2"
            onClick={() => {
              onRunNow(entry);
            }}
          >
            <IconPlayerPlay size={14} stroke={1.5} />
            {running ? "Starting\u2026" : "Run now"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="gap-2"
          onClick={() => {
            return onEdit(entry);
          }}
        >
          <IconPencil size={14} stroke={1.5} />
          Edit
        </DropdownMenuItem>
        {onDelete && entry.name !== undefined && (
          <DropdownMenuItem
            className="gap-2 text-destructive focus:text-destructive"
            onClick={() => {
              return onDelete(entry);
            }}
          >
            <IconTrash size={14} stroke={1.5} />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Mobile card row
// ---------------------------------------------------------------------------

function ScheduleListCard<T extends ScheduleEntry>({
  entry,
  toggling,
  running,
  showAgent,
  agentLabel,
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  onOpenDetails,
}: {
  entry: T;
  toggling: boolean;
  running: boolean;
  showAgent: boolean;
  agentLabel?: string;
  onEdit: (entry: T) => void;
  onToggle?: (entry: T, enabled: boolean) => void;
  onDelete?: (entry: T) => void;
  onRunNow?: (entry: T) => void;
  onOpenDetails?: (entry: T) => void;
}) {
  const dimmed = entry.enabled === false;
  const clickable = !!onOpenDetails;

  return (
    <div
      className={cn(
        "relative flex items-center gap-2 px-5 py-3 border-b border-border/50 last:border-0 transition-colors",
        clickable && "hover:bg-muted/25",
        dimmed && "opacity-75",
      )}
    >
      {clickable && (
        <Link
          pathname="/schedules/:scheduleId"
          options={{ pathParams: { scheduleId: entry.id } }}
          aria-label={`Open schedule ${entry.prompt}`}
          className="absolute inset-0 z-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
        >
          <span className="sr-only">Open schedule {entry.prompt}</span>
        </Link>
      )}
      {/* Left: text content — pointer-events disabled so clicks pass through to the Link overlay */}
      <div className="min-w-0 flex-1 flex flex-col gap-0.5 pointer-events-none">
        {showAgent && (
          <span className="block text-sm font-medium text-foreground truncate">
            {agentLabel}
          </span>
        )}
        <span
          className={cn(
            "block text-sm text-foreground leading-snug truncate",
            dimmed && "text-muted-foreground",
          )}
        >
          {entry.description || entry.prompt}
        </span>
        <span
          className={cn(
            "text-sm text-muted-foreground tabular-nums truncate",
            dimmed && "text-muted-foreground/80",
          )}
        >
          {entry.time}
          {entry.timezone && (
            <span className="text-muted-foreground/70">
              {" "}
              · {entry.timezone.replace(/_/g, " ")}
            </span>
          )}
        </span>
      </div>

      {/* Right: toggle + more button — relative + z-10 so they sit above the link overlay */}
      <div className="relative z-10 flex items-center gap-4 shrink-0">
        {onToggle && (
          <LoadingSwitch
            checked={entry.enabled !== false}
            loading={toggling}
            onCheckedChange={(checked) => {
              onToggle(entry, checked);
            }}
            ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} ${entry.time}`}
          />
        )}
        <RowActions
          entry={entry}
          running={running}
          onEdit={onEdit}
          onDelete={onDelete}
          onRunNow={onRunNow}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule list view (shared between schedule page and schedule card)
// ---------------------------------------------------------------------------

export function ScheduleListView<T extends ScheduleEntry>({
  entries,
  togglingIds,
  runningIds,
  getAgentLabel,
  onEdit,
  onToggle,
  onDelete,
  onNew,
  onRunNow,
  onOpenDetails,
}: {
  entries: T[];
  togglingIds: Set<string>;
  runningIds?: Set<string>;
  getAgentLabel?: (entry: T) => string;
  onEdit: (entry: T) => void;
  onToggle?: (entry: T, enabled: boolean) => void;
  onDelete?: (entry: T) => void;
  onNew?: () => void;
  onRunNow?: (entry: T) => void;
  onOpenDetails?: (entry: T) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <img
          src={emptyScheduleImg}
          alt="No schedules"
          className="h-20 w-20 object-contain opacity-80"
        />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            No runs scheduled
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Set up a schedule and your agents will handle the rest.
          </p>
        </div>
        {onNew && (
          <Button
            variant="outline"
            size="sm"
            className="zero-btn-morandi mt-2 h-9 gap-2 rounded-lg border"
            onClick={onNew}
          >
            <IconPlus size={14} stroke={2} />
            Add schedule
          </Button>
        )}
      </div>
    );
  }

  const showAgent = !!getAgentLabel;

  return (
    <>
      {/* Mobile: card list — same data as the desktop table; hidden from
          the accessibility tree so screen-reader / test queries don't find
          duplicate nodes (CSS hides one layout at a time in real browsers). */}
      <div className="sm:hidden pb-2" aria-hidden="true">
        {entries.map((entry) => {
          return (
            <ScheduleListCard
              key={entry.id}
              entry={entry}
              toggling={togglingIds.has(entry.id)}
              running={runningIds?.has(entry.id) ?? false}
              showAgent={showAgent}
              agentLabel={getAgentLabel?.(entry)}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
              onRunNow={onRunNow}
              onOpenDetails={onOpenDetails}
            />
          );
        })}
      </div>

      {/* Desktop: table */}
      <div className="hidden sm:block w-full overflow-x-auto pb-2">
        <table className="w-full text-sm border-collapse [&_tr>:first-child]:pl-5 [&_tr>:last-child]:pr-5">
          <thead>
            <tr className="border-b border-border/40 bg-card text-left text-sm text-muted-foreground">
              {showAgent && (
                <th
                  className="py-3 pr-2 w-[5rem] align-middle font-medium"
                  scope="col"
                >
                  Agent
                </th>
              )}
              <th
                className="py-3 pr-4 min-w-0 align-middle font-medium"
                scope="col"
              >
                Instruction
              </th>
              <th
                className="py-3 px-2 min-w-[6.5rem] max-w-[9rem] align-middle font-medium"
                scope="col"
              >
                Schedule at
              </th>
              {onToggle && (
                <th
                  className="py-3 px-3 w-16 text-center align-middle font-medium"
                  scope="col"
                >
                  Status
                </th>
              )}
              <th className="w-10 py-3 pl-2 align-middle" scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              return (
                <ScheduleListRow
                  key={entry.id}
                  entry={entry}
                  toggling={togglingIds.has(entry.id)}
                  running={runningIds?.has(entry.id) ?? false}
                  showAgent={showAgent}
                  agentLabel={getAgentLabel?.(entry)}
                  onEdit={onEdit}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onRunNow={onRunNow}
                  onOpenDetails={onOpenDetails}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
