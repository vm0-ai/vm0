import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconNetwork,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react";
import {
  Skeleton,
  Popover,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@vm0/ui";
import {
  networkInsightsData$,
  insightsDateRange$,
  setInsightsDateRange$,
  insightsCalendarOpen$,
  setInsightsCalendarOpen$,
  insightsCalendarYear$,
  setInsightsCalendarYear$,
  insightsCalendarMonth$,
  setInsightsCalendarMonth$,
  insightsHoveredAgent$,
  setInsightsHoveredAgent$,
  expandedAllowedDays$,
  toggleExpandedAllowed$,
  type DayInsight,
  type NetworkInsightsData,
} from "../../signals/network-insights/network-insights-signals.ts";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { user$ } from "../../signals/auth.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";

// ---------------------------------------------------------------------------
// Date range filter
// ---------------------------------------------------------------------------

/** A preset range or a specific ISO date string like "2026-04-03". */
type DateRange = "last7" | "last28" | "last30" | (string & {});

/** Get yesterday's date string (YYYY-MM-DD) in the given IANA timezone. */
function yesterdayIso(tz: string): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Get a date string N days ago (YYYY-MM-DD) in the given IANA timezone. */
function daysAgoIso(n: number, tz: string): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function dateRangeLabel(range: DateRange): string {
  switch (range) {
    case "last7": {
      return "Last 7 Days";
    }
    case "last28": {
      return "Last 28 Days";
    }
    case "last30": {
      return "Last 30 Days";
    }
    default: {
      return formatDateShort(range);
    }
  }
}

/** Short date label for dropdown items, e.g. "Apr 3" or "Today". */
function formatDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = now.getTime() - d.getTime();
  const dayMs = 86_400_000;
  if (diff < dayMs) {
    return "Today";
  }
  if (diff < dayMs * 2) {
    return "Yesterday";
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Filter days that fall within the selected range or match a specific date. */
function filterDays(
  days: DayInsight[],
  range: DateRange,
  tz: string,
): DayInsight[] {
  if (range !== "last7" && range !== "last28" && range !== "last30") {
    return days.filter((d) => {
      return d.date === range;
    });
  }

  const n = range === "last7" ? 7 : range === "last28" ? 28 : 30;
  const cutoff = daysAgoIso(n, tz);

  return days.filter((d) => {
    return d.date >= cutoff;
  });
}

// ---------------------------------------------------------------------------
// Calendar popover for custom date selection
// ---------------------------------------------------------------------------

function CalendarMonth({
  year,
  month,
  selected,
  hasData,
  onSelect,
}: {
  year: number;
  month: number;
  selected: string | null;
  hasData: Set<string>;
  onSelect: (iso: string) => void;
}) {
  const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const first = new Date(year, month, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Compute padding keys from previous month's trailing days
  const padKeys = Array.from({ length: startDay }, (_, n) => {
    const prevDate = new Date(year, month, -(startDay - 1 - n));
    return `pad-${prevDate.getFullYear()}-${prevDate.getMonth()}-${prevDate.getDate()}`;
  });

  return (
    <div className="grid grid-cols-7 gap-0.5 text-center">
      {weekdays.map((d) => {
        return (
          <span
            key={d}
            className="text-[10px] text-muted-foreground font-medium py-1"
          >
            {d}
          </span>
        );
      })}
      {padKeys.map((k) => {
        return <span key={k} />;
      })}
      {Array.from({ length: daysInMonth }, (_, n) => {
        const day = n + 1;
        const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const active = hasData.has(iso);
        const isSelected = selected === iso;
        return (
          <button
            key={iso}
            type="button"
            disabled={!active}
            onClick={() => {
              onSelect(iso);
            }}
            className={`text-xs h-7 w-7 mx-auto rounded-full transition-colors ${
              isSelected
                ? "bg-foreground text-background font-semibold"
                : active
                  ? "hover:bg-muted font-medium text-foreground"
                  : "text-muted-foreground/30"
            }`}
          >
            {day}
            {active && !isSelected && (
              <span className="block mx-auto w-1 h-1 rounded-full bg-foreground/40 -mt-0.5" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function CustomRangePicker({
  value,
  onChange,
  availableDates,
}: {
  value: DateRange;
  onChange: (v: DateRange) => void;
  availableDates: string[];
}) {
  const open = useGet(insightsCalendarOpen$);
  const setOpen = useSet(setInsightsCalendarOpen$);
  const hasData = new Set(availableDates);

  const viewYear = useGet(insightsCalendarYear$);
  const setViewYear = useSet(setInsightsCalendarYear$);
  const viewMonth = useGet(insightsCalendarMonth$);
  const setViewMonth = useSet(setInsightsCalendarMonth$);

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric" },
  );

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear(viewYear - 1);
      setViewMonth(11);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear(viewYear + 1);
      setViewMonth(0);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const selectedDate = isPreset(value) ? null : value;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left hover:bg-accent transition-colors ${
            !isPreset(value) ? "font-semibold" : ""
          }`}
        >
          Custom Range
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={12}
        className="w-auto p-3"
      >
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={prevMonth}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted transition-colors"
          >
            <IconChevronLeft size={14} stroke={1.5} />
          </button>
          <p className="text-sm font-semibold">{monthLabel}</p>
          <button
            type="button"
            onClick={nextMonth}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted transition-colors"
          >
            <IconChevronRight size={14} stroke={1.5} />
          </button>
        </div>
        <CalendarMonth
          year={viewYear}
          month={viewMonth}
          selected={selectedDate}
          hasData={hasData}
          onSelect={(iso) => {
            onChange(iso);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Date range dropdown
// ---------------------------------------------------------------------------

function isPreset(v: DateRange): v is "last7" | "last28" | "last30" {
  return v === "last7" || v === "last28" || v === "last30";
}

const PRESETS = ["last7", "last28", "last30"] as const;

function DateRangeFilter({
  value,
  onChange,
  availableDates,
  timezone,
}: {
  value: DateRange;
  onChange: (v: DateRange) => void;
  availableDates: string[];
  timezone: string;
}) {
  const yesterday = yesterdayIso(timezone);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          {dateRangeLabel(value)}
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {availableDates.includes(yesterday) && (
          <DropdownMenuItem
            onClick={() => {
              onChange(yesterday);
            }}
            className={
              !isPreset(value) && value === yesterday ? "font-semibold" : ""
            }
          >
            Yesterday
          </DropdownMenuItem>
        )}
        {availableDates.includes(yesterday) && <DropdownMenuSeparator />}
        {PRESETS.map((preset) => {
          return (
            <DropdownMenuItem
              key={preset}
              onClick={() => {
                onChange(preset);
              }}
              className={value === preset ? "font-semibold" : ""}
            >
              {dateRangeLabel(preset)}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <CustomRangePicker
          value={value}
          onChange={onChange}
          availableDates={availableDates}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Summary card — fun one-liner based on today's data
// ---------------------------------------------------------------------------

/**
 * Pick a deterministic "random" index from a pool based on the day string,
 * so the same day always gets the same quote but different days vary.
 */
function dayHash(date: string, poolSize: number): number {
  let h = 0;
  for (let i = 0; i < date.length; i++) {
    h = (h * 31 + date.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % poolSize;
}

function buildSummaryQuote(day: DayInsight): {
  quote: string;
  caption: string;
} {
  const totalRuns = day.agents.reduce((s, a) => {
    return s + a.runs;
  }, 0);
  const totalCalls = day.services.reduce((s, svc) => {
    return s + svc.calls;
  }, 0);
  const blocked = day.permissions.reduce((s, p) => {
    return s + p.denied;
  }, 0);
  let quote: string;
  let caption: string;

  if (blocked > 0) {
    quote = `${blocked} requests were blocked by your permission rules. Review them to make sure nothing important is being held back.`;
    caption = `${totalCalls} calls · ${blocked} blocked`;
  } else if (totalRuns > 8) {
    quote = `A busy day — ${day.agents.length} agents completed ${totalRuns} runs. Your network is working hard.`;
    caption = `${totalRuns} runs · ${day.agents.length} agents`;
  } else if (totalCalls > 100) {
    quote = `${totalCalls} service calls across ${day.services.length} services. High traffic day.`;
    caption = `${totalCalls} calls · ${day.services.length} services`;
  } else if (day.agents.length >= 4) {
    quote = `${day.agents.length} agents active, using ${day.creditsUsed} credits total. A well-distributed workload.`;
    caption = `${day.agents.length} agents · ${day.creditsUsed} credits`;
  } else if (totalRuns <= 2 && totalCalls < 30) {
    quote = `Light activity — ${totalRuns === 0 ? "no runs" : `only ${totalRuns} ${totalRuns === 1 ? "run" : "runs"}`} and ${totalCalls} calls. A quiet day.`;
    caption = `${totalRuns} ${totalRuns === 1 ? "run" : "runs"} · a quiet day`;
  } else {
    quote = `${totalRuns} runs and ${totalCalls} service calls today. Everything running smoothly.`;
    caption = `${totalRuns} runs · ${totalCalls} calls`;
  }

  return { quote, caption };
}

function SummaryCard({ day }: { day: DayInsight }) {
  const { quote, caption } = buildSummaryQuote(day);
  const variants: { bg: string; dark: boolean }[] = [
    { bg: "bg-[#98928B]", dark: true }, // taupe
    { bg: "bg-[#EFC184]", dark: false }, // sandy orange
    { bg: "bg-[#F3B8B1]", dark: false }, // rose pink
    { bg: "bg-[#EC70A5]", dark: true }, // hot pink
    { bg: "bg-[#358A8E]", dark: true }, // teal
    { bg: "bg-[#E1C43C]", dark: false }, // mustard gold
  ];
  const v = variants[dayHash(day.date, variants.length)] ?? variants[0];
  const textMain = v.dark ? "text-white/90" : "text-foreground/90";
  const textSub = v.dark ? "text-white/50" : "text-foreground/50";

  return (
    <div
      className={`${v.bg} rounded-[20px] p-7 flex flex-col justify-between min-h-[180px] mb-3 break-inside-avoid`}
    >
      <div>
        <p className={`${textSub} text-3xl leading-none mb-3 font-serif`}>
          &ldquo;
        </p>
        <p
          className={`text-xl font-medium leading-relaxed italic font-serif ${textMain}`}
        >
          {quote}
        </p>
      </div>
      <p className={`text-xs ${textSub} mt-4 tracking-wide uppercase`}>
        {caption}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CardPalette {
  bg: string;
  accent: string;
}

function getCardPalette(colorIndex: number): CardPalette {
  const palette: CardPalette[] = [
    { bg: "bg-[#EFC184]/20", accent: "#D4956A" }, // sandy orange — brand original
    { bg: "bg-[#F3B8B1]/20", accent: "#E24B6A" }, // rose → brand vibrant rose
    { bg: "bg-[#E1C43C]/15", accent: "#E1C43C" }, // mustard gold — brand original
    { bg: "bg-gray-50", accent: "#98928B" }, // grey-50 → taupe
    { bg: "bg-[#EC70A5]/15", accent: "#EC70A5" }, // hot pink — brand original
    { bg: "bg-[#358A8E]/15", accent: "#358A8E" }, // teal — brand original
    { bg: "bg-[#98928B]/15", accent: "#98928B" }, // taupe — brand original
  ];
  return palette[colorIndex % palette.length] ?? palette[0];
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-gray-50 text-foreground rounded-[20px] p-6 border border-border/40 relative overflow-hidden mb-3 break-inside-avoid">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card: Agents used
// ---------------------------------------------------------------------------

function AgentsCard({
  day,
  colorIndex,
  hoveredAgent,
  onHoverAgent,
}: {
  day: DayInsight;
  colorIndex: number;
  hoveredAgent: string | null;
  onHoverAgent: (name: string | null) => void;
}) {
  const totalRuns = day.agents.reduce((s, a) => {
    return s + a.runs;
  }, 0);
  const { accent } = getCardPalette(colorIndex);
  return (
    <Card>
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Agents
      </p>
      <div className="flex items-center mb-3">
        <span className="text-3xl font-black tabular-nums font-serif">
          {day.agents.length}
        </span>
      </div>
      <p className="text-sm opacity-60">
        {day.agents.length === 1 ? "agent" : "agents"} ran {totalRuns}{" "}
        {totalRuns === 1 ? "time" : "times"}
      </p>
      <div className="flex flex-col gap-2 mt-3">
        {day.agents.map((a) => {
          const isActive =
            hoveredAgent === null || hoveredAgent === a.agentName;
          return (
            <div
              key={a.agentName}
              className={`flex items-center gap-2 rounded-md px-1.5 py-0.5 -mx-1.5 cursor-default transition-all duration-150 ${
                hoveredAgent === a.agentName ? "bg-foreground/5" : ""
              } ${isActive ? "opacity-100" : "opacity-30"}`}
              onMouseEnter={() => {
                onHoverAgent(a.agentName);
              }}
              onMouseLeave={() => {
                onHoverAgent(null);
              }}
            >
              <span className="text-sm font-medium flex-1 truncate decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-2">
                {a.agentName}
              </span>
              <span className="text-xs opacity-60 tabular-nums shrink-0">
                {a.runs} {a.runs === 1 ? "run" : "runs"}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Card: Team credit usage (admin-only)
// ---------------------------------------------------------------------------

function TeamCreditUsageCard({
  day,
  colorIndex,
  hoveredAgent,
}: {
  day: DayInsight;
  colorIndex: number;
  hoveredAgent: string | null;
}) {
  const hoveredAgentData = hoveredAgent
    ? day.agents.find((a) => {
        return a.agentName === hoveredAgent;
      })
    : null;
  const displayCredits = hoveredAgentData
    ? hoveredAgentData.credits
    : day.creditsUsed;

  const sorted = [...day.teamUsage].sort((a, b) => {
    return b.credits - a.credits;
  });
  const maxCredits = Math.max(
    1,
    ...sorted.map((m) => {
      return m.credits;
    }),
  );
  const { accent } = getCardPalette(colorIndex);

  return (
    <Card>
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Team Credit Usage
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif transition-all duration-150">
        {displayCredits.toLocaleString()}
      </p>
      <p className="text-sm opacity-60 mt-2">
        {hoveredAgentData
          ? `by ${hoveredAgentData.agentName}`
          : "consumed today"}
      </p>

      <div className="flex items-center justify-between mt-4">
        <span className="text-sm opacity-60">Balance</span>
        <span className="text-sm font-semibold tabular-nums">
          {day.creditBalance.toLocaleString()}
        </span>
      </div>

      {sorted.length > 0 && (
        <div className="mt-4">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-3"
            style={{ color: accent }}
          >
            Team
          </p>
          <div className="flex flex-col gap-2">
            {sorted.map((m) => {
              const isActive =
                hoveredAgent === null || m.agentNames?.includes(hoveredAgent);
              const memberCredits =
                hoveredAgent &&
                m.agentCredits?.[hoveredAgent] !== null &&
                m.agentCredits?.[hoveredAgent] !== undefined
                  ? m.agentCredits[hoveredAgent]
                  : m.credits;
              const pct = (memberCredits / maxCredits) * 100;
              return (
                <div
                  key={m.name}
                  className={`flex items-center gap-3 transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-30"}`}
                >
                  <span className="text-sm w-20 truncate shrink-0">
                    {m.name}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-current/10 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: accent,
                      }}
                    />
                  </div>
                  <span className="text-xs opacity-60 w-10 text-right shrink-0 tabular-nums">
                    {memberCredits}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Card: Your credit usage (everyone)
// ---------------------------------------------------------------------------

function YourCreditUsageCard({
  day,
  colorIndex,
  userId,
  hoveredAgent,
}: {
  day: DayInsight;
  colorIndex: number;
  userId: string | null;
  hoveredAgent: string | null;
}) {
  const { accent } = getCardPalette(colorIndex);
  const myUsage = userId
    ? day.teamUsage.find((m) => {
        return m.userId === userId;
      })
    : null;
  const displayCredits =
    hoveredAgent && myUsage?.agentCredits?.[hoveredAgent] !== undefined
      ? myUsage.agentCredits[hoveredAgent]
      : (myUsage?.credits ?? 0);
  const hoveredAgentData = hoveredAgent
    ? day.agents.find((a) => {
        return a.agentName === hoveredAgent;
      })
    : null;

  return (
    <Card>
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Your Credit Usage
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif transition-all duration-150">
        {displayCredits.toLocaleString()}
      </p>
      <p className="text-sm opacity-60 mt-2">
        {hoveredAgentData
          ? `by ${hoveredAgentData.agentName}`
          : "consumed today"}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Card: Top task
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Card: Services accessed
// ---------------------------------------------------------------------------

function connectorLabel(type: string): string {
  const config = CONNECTOR_TYPES[type as ConnectorType];
  if (config) {
    return config.label;
  }
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function permissionLabel(p: { label: string; connectorType?: string }): string {
  if (!p.connectorType || p.label === p.connectorType) {
    return connectorLabel(p.label);
  }
  return `${connectorLabel(p.connectorType)}(${p.label})`;
}

function ServicesCard({
  day,
  colorIndex,
  hoveredAgent,
}: {
  day: DayInsight;
  colorIndex: number;
  hoveredAgent: string | null;
}) {
  const maxCalls = Math.max(
    1,
    ...day.services.map((s) => {
      return s.calls;
    }),
  );
  const sorted = [...day.services].sort((a, b) => {
    return b.calls - a.calls;
  });
  const top = sorted[0];
  const { accent } = getCardPalette(colorIndex);

  return (
    <Card>
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Services
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {day.services.length}
      </p>
      {top && (
        <p className="text-sm opacity-60 mt-2">
          Most used:{" "}
          <span className="font-semibold opacity-100">
            {connectorLabel(top.domain)}
          </span>{" "}
          ({top.calls} calls)
        </p>
      )}
      <div className="flex flex-col gap-2.5 mt-4">
        {sorted.map((s) => {
          const isActive =
            hoveredAgent === null || s.agentNames.includes(hoveredAgent);
          const pct = (s.calls / maxCalls) * 100;
          return (
            <div
              key={s.domain}
              className={`flex items-center gap-3 transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-30"}`}
            >
              <span className="text-sm font-medium w-20 truncate shrink-0">
                {connectorLabel(s.domain)}
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-current/10 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, backgroundColor: accent }}
                />
              </div>
              <span className="text-xs opacity-60 w-8 text-right shrink-0 tabular-nums">
                {s.calls}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Card: Permissions
// ---------------------------------------------------------------------------

const ALLOWED_INITIAL_COUNT = 5;

function PermissionsAllowedCard({
  day,
  colorIndex,
  hoveredAgent,
}: {
  day: DayInsight;
  colorIndex: number;
  hoveredAgent: string | null;
}) {
  const expandedDays = useGet(expandedAllowedDays$);
  const toggleExpanded = useSet(toggleExpandedAllowed$);
  const expanded = expandedDays.has(day.date);

  const allowed = day.permissions.filter((p) => {
    return p.allowed > 0;
  });

  if (allowed.length === 0) {
    return null;
  }

  const totalAllowed = allowed.reduce((s, p) => {
    return s + p.allowed;
  }, 0);
  const { accent } = getCardPalette(colorIndex);
  const visible = expanded ? allowed : allowed.slice(0, ALLOWED_INITIAL_COUNT);
  const hasMore = allowed.length > ALLOWED_INITIAL_COUNT;

  return (
    <Card>
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Allowed
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalAllowed}
      </p>
      <p className="text-sm opacity-60 mt-2">
        calls made within {allowed.length} granted{" "}
        {allowed.length === 1 ? "permission" : "permissions"}
      </p>
      <div className="flex flex-col gap-3 mt-4">
        {visible.map((p) => {
          const isActive =
            hoveredAgent === null || p.agentNames.includes(hoveredAgent);
          const hasDescription = p.connectorType && p.label !== p.connectorType;
          return (
            <div
              key={`${p.connectorType ?? ""}:${p.label}`}
              className={`transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-30"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-2">
                  {connectorLabel(p.connectorType ?? p.label)}
                </span>
                <span className="text-xs opacity-60 tabular-nums shrink-0">
                  {p.allowed} {p.allowed === 1 ? "call" : "calls"}
                </span>
              </div>
              {hasDescription && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {p.label}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => {
            toggleExpanded(day.date);
          }}
          className="text-xs font-medium mt-3"
          style={{ color: accent }}
        >
          {expanded ? "Show less" : "Load more"}
        </button>
      )}
    </Card>
  );
}

function PermissionsBlockedCard({
  day,
  hoveredAgent,
}: {
  day: DayInsight;
  hoveredAgent: string | null;
}) {
  const blocked = day.permissions.filter((p) => {
    return p.denied > 0;
  });

  if (blocked.length === 0) {
    return null;
  }

  const totalBlocked = blocked.reduce((s, p) => {
    return s + p.denied;
  }, 0);

  const { accent } = getCardPalette(4);

  return (
    <Card>
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Protected
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalBlocked}
      </p>
      <p className="text-sm opacity-60 mt-2">
        calls protected across {blocked.length}{" "}
        {blocked.length === 1 ? "permission" : "permissions"}
      </p>
      <div className="flex flex-col gap-2 mt-4">
        {blocked.map((p) => {
          const isActive =
            hoveredAgent === null || p.agentNames.includes(hoveredAgent);
          const fullyBlocked = p.allowed === 0;
          return (
            <div
              key={`${p.connectorType ?? ""}:${p.label}`}
              className={`flex items-center justify-between gap-2 transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-30"}`}
            >
              <span className="text-sm font-medium">{permissionLabel(p)}</span>
              <span className="text-xs tabular-nums shrink-0 opacity-70">
                {fullyBlocked
                  ? `${p.denied} rejected`
                  : `${p.denied} of ${p.allowed + p.denied} rejected`}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Date header
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = today.getTime() - d.getTime();
  const dayMs = 86_400_000;

  if (diff < dayMs) {
    return "Today";
  }
  if (diff < dayMs * 2) {
    return "Yesterday";
  }

  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Day section — masonry of cards (dim approach for hover)
// ---------------------------------------------------------------------------

function DaySection({
  day,
  isAdmin,
  userId,
}: {
  day: DayInsight;
  isAdmin: boolean;
  userId: string | null;
}) {
  const hoveredAgent = useGet(insightsHoveredAgent$);
  const setHoveredAgent = useSet(setInsightsHoveredAgent$);

  const handleHoverAgent = (name: string | null) => {
    setHoveredAgent(name);
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground sticky top-0 bg-background/80 backdrop-blur-sm py-2 z-10">
        {formatDate(day.date)}
      </h2>
      <div className="columns-1 sm:columns-2 lg:columns-3 gap-3">
        <SummaryCard day={day} />
        {isAdmin && (
          <TeamCreditUsageCard
            day={day}
            colorIndex={1}
            hoveredAgent={hoveredAgent}
          />
        )}
        <YourCreditUsageCard
          day={day}
          colorIndex={1}
          userId={userId}
          hoveredAgent={hoveredAgent}
        />
        <AgentsCard
          day={day}
          colorIndex={0}
          hoveredAgent={hoveredAgent}
          onHoverAgent={handleHoverAgent}
        />
        <ServicesCard day={day} colorIndex={2} hoveredAgent={hoveredAgent} />
        <PermissionsAllowedCard
          day={day}
          colorIndex={5}
          hoveredAgent={hoveredAgent}
        />
        <PermissionsBlockedCard day={day} hoveredAgent={hoveredAgent} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Last updated label
// ---------------------------------------------------------------------------

/** Format an ISO timestamp as a locale-aware absolute time. */
function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Main content
// ---------------------------------------------------------------------------

function InsightsContent({ data }: { data: NetworkInsightsData }) {
  const dateRange = useGet(insightsDateRange$);
  const setRange = useSet(setInsightsDateRange$);
  const prefsLoadable = useLastLoadable(userPreferences$);
  const adminLoadable = useLastLoadable(isOrgAdmin$);
  const userLoadable = useLastLoadable(user$);
  const timezone =
    prefsLoadable.state === "hasData" && prefsLoadable.data?.timezone
      ? prefsLoadable.data.timezone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const filtered = filterDays(data.days, dateRange, timezone);

  const isAdmin =
    adminLoadable.state === "hasData" ? adminLoadable.data : false;
  const userId =
    userLoadable.state === "hasData" ? (userLoadable.data?.id ?? null) : null;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[960px] px-4 sm:px-8 py-8 flex flex-col gap-10">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold">Insights</h1>
              {data.lastUpdated && (
                <span className="text-xs text-muted-foreground">
                  Last updated {formatAbsoluteTime(data.lastUpdated)}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor what your agents access, which permissions they use, and
              spot anything unusual.
            </p>
          </div>
          {data.days.length > 0 && (
            <DateRangeFilter
              value={dateRange}
              onChange={setRange}
              availableDates={data.days.map((d) => {
                return d.date;
              })}
              timezone={timezone}
            />
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
              <IconNetwork
                size={28}
                stroke={1}
                className="text-muted-foreground"
              />
            </div>
            <p className="text-sm text-muted-foreground max-w-xs">
              {data.days.length === 0
                ? "Run an agent to see insights here."
                : "No activity in this time range."}
            </p>
          </div>
        ) : (
          filtered.map((day) => {
            return (
              <DaySection
                key={day.date}
                day={day}
                isAdmin={isAdmin}
                userId={userId}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function InsightsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[960px] px-4 sm:px-8 py-8 flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-52" />
      </div>
      <div className="columns-1 sm:columns-2 lg:columns-3 gap-3">
        <Skeleton className="h-44 rounded-[20px] mb-3 break-inside-avoid" />
        <Skeleton className="h-56 rounded-[20px] mb-3 break-inside-avoid" />
        <Skeleton className="h-36 rounded-[20px] mb-3 break-inside-avoid" />
        <Skeleton className="h-28 rounded-[20px] mb-3 break-inside-avoid" />
        <Skeleton className="h-48 rounded-[20px] mb-3 break-inside-avoid" />
        <Skeleton className="h-64 rounded-[20px] mb-3 break-inside-avoid" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page entry point
// ---------------------------------------------------------------------------

export function NetworkInsightsPage() {
  const dataLoadable = useLastLoadable(networkInsightsData$);

  if (dataLoadable.state === "loading" || dataLoadable.state === "hasError") {
    return (
      <div className="h-full overflow-auto">
        <InsightsSkeleton />
      </div>
    );
  }

  const data = dataLoadable.data;
  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Could not load network activity.</p>
      </div>
    );
  }

  return <InsightsContent data={data} />;
}
