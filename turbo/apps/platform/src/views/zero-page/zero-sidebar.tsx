import type { ComponentType } from "react";
import {
  IconMessageCircle,
  IconRobot,
  IconFileText,
  IconFile,
  IconChartLine,
  IconSelector,
  IconLayoutGrid,
  IconSettings,
  IconDotsVertical,
  IconCalendar,
} from "@tabler/icons-react";

export type ZeroNavId =
  | "chat"
  | "meet"
  | "schedule"
  | "job"
  | "production"
  | "activity"
  | "works"
  | "team"
  | "account";

const MAIN_NAV: {
  id: ZeroNavId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}[] = [
  { id: "chat", label: "Chat with Zero", icon: IconMessageCircle },
  { id: "meet", label: "Meet Zero", icon: IconRobot },
  { id: "job", label: "Zero's team", icon: IconFileText },
  { id: "schedule", label: "Schedule", icon: IconCalendar },
  { id: "production", label: "Documents", icon: IconFile },
  { id: "activity", label: "Activities", icon: IconChartLine },
];

const RECENT_ITEMS: { id: string; label: string }[] = [
  { id: "1", label: "Daily digest workflow" },
  { id: "2", label: "Set up Slack integration" },
  { id: "3", label: "Weekly report automation" },
  { id: "4", label: "Code review reminders" },
];

const FOOTER_NAV: {
  id: ZeroNavId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}[] = [
  { id: "works", label: "Where Zero works", icon: IconLayoutGrid },
  { id: "team", label: "Workspace settings", icon: IconSettings },
];

interface ZeroSidebarProps {
  activeId: ZeroNavId;
  onSelect: (id: ZeroNavId) => void;
  onRecentSelect?: (id: string) => void;
  selectedRecentId?: string | null;
}

export function ZeroSidebar({
  activeId,
  onSelect,
  onRecentSelect,
  selectedRecentId = null,
}: ZeroSidebarProps) {
  const accountName = "Alex Chen";
  const accountEmail = "alex@example.com";
  const accountInitial = "A";

  return (
    <aside className="zero-nav flex h-full w-[255px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
      {/* Zero + workspace — single module */}
      <div className="shrink-0 p-2 pb-1">
        <div className="rounded-lg p-2 transition-colors duration-200 hover:bg-sidebar-accent/50">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 shrink-0 flex items-center justify-center overflow-hidden rounded-full">
              <img
                src="/zero-avatar.png"
                alt="Zero"
                className="h-8 w-8 rounded-full object-cover object-top"
                width={32}
                height={32}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-tight text-sidebar-foreground truncate">
                Personal Workspace
              </p>
              <p className="text-xs leading-tight text-sidebar-foreground opacity-70 truncate mt-px">
                Free • Owner
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 flex h-7 w-7 items-center justify-center rounded text-sidebar-foreground hover:bg-sidebar-accent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch workspace"
            >
              <IconSelector size={14} stroke={1.5} />
            </button>
          </div>
        </div>
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
        <div className="flex flex-col gap-1">
          {MAIN_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                activeId === id
                  ? "bg-sidebar-active text-sidebar-primary font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        {/* Recent dialogue — no extra wrapper padding so label/items align with main nav (nav already has p-2) */}
        <div className="mt-4">
          <div className="zero-nav-recent-label h-8 flex items-center px-2">
            <span className="text-xs leading-4 text-sidebar-foreground uppercase tracking-wider">
              recent chat
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {RECENT_ITEMS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => onRecentSelect?.(id)}
                className={`flex h-8 items-center rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
                  selectedRecentId === id
                    ? "bg-sidebar-active text-sidebar-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Footer nav */}
      <div className="p-2">
        <div className="flex flex-col gap-1">
          {FOOTER_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                activeId === id
                  ? "bg-sidebar-active text-sidebar-primary font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
          {/* Account — mock name, avatar, email */}
          <div className="mt-2 pt-1">
            <button
              type="button"
              onClick={() => onSelect("account")}
              className={`flex w-full items-center gap-2 rounded-lg p-2 h-12 text-left transition-colors duration-200 ${
                activeId === "account"
                  ? "bg-sidebar-active text-sidebar-primary"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
            >
              <div className="h-8 w-8 rounded-lg bg-sidebar-accent overflow-hidden shrink-0 flex items-center justify-center text-sidebar-foreground/70 text-sm font-medium">
                {accountInitial}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm leading-5 text-sidebar-foreground truncate">
                  {accountName}
                </div>
                <div className="text-xs leading-4 text-sidebar-foreground/70 truncate">
                  {accountEmail}
                </div>
              </div>
              <IconDotsVertical
                size={16}
                stroke={1.5}
                className="text-sidebar-foreground shrink-0"
              />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
