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
  IconUser,
} from "@tabler/icons-react";

export type ZeroNavId =
  | "chat"
  | "meet"
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
  { id: "job", label: "Zero's job", icon: IconFileText },
  { id: "production", label: "Zero's production", icon: IconFile },
  { id: "activity", label: "Zero's activity", icon: IconChartLine },
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
  { id: "team", label: "Zero's team", icon: IconSettings },
  { id: "account", label: "Account", icon: IconUser },
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
  return (
    <aside className="zero-nav flex h-full w-[255px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
      {/* Zero avatar + Zero's home — top of nav */}
      <div className="flex h-[49px] shrink-0 flex-col justify-center border-b border-divider p-2">
        <div className="flex h-8 items-center gap-2.5 p-2">
          <img
            src="/zero-avatar.png"
            alt="Zero"
            className="h-8 w-8 shrink-0 rounded-full object-cover object-top block align-middle -mt-1"
            width={32}
            height={32}
          />
          <span className="text-xl font-semibold leading-8 text-sidebar-foreground shrink-0">
            {"Zero's home"}
          </span>
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
      <div className="p-2 border-t border-divider">
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
        </div>
        {/* Workspace selector — below Account, bottom of nav */}
        <div className="mt-2">
          <div className="flex items-center gap-2 rounded-lg bg-sidebar-accent px-2 py-2.5 transition-colors duration-200">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-5 text-sidebar-foreground">
                Personal Workspace
              </p>
              <p className="truncate text-xs leading-4 text-sidebar-foreground opacity-70">
                Free • Owner
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded p-1 text-sidebar-foreground hover:bg-sidebar-accent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch workspace"
            >
              <IconSelector size={16} stroke={1.5} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
