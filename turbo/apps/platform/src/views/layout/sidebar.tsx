import { useGet } from "ccstate-react";
import { MoreVertical } from "lucide-react";
import {
  NAVIGATION_CONFIG,
  FOOTER_NAV_ITEMS,
  GET_STARTED_ITEM,
  activeNavItem$,
} from "../../signals/layout/navigation.ts";
import { NavLink } from "./nav-link.tsx";

export function Sidebar() {
  const activeItem = useGet(activeNavItem$);

  return (
    <aside className="hidden md:flex w-[255px] flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo header */}
      <div className="h-[49px] flex items-center px-2 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 px-1.5">
          <VM0Logo />
          <span className="text-2xl text-sidebar-foreground">Platform</span>
        </div>
      </div>

      {/* Main navigation area */}
      <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
        {/* Get started (standalone) */}
        <div className="p-2">
          <NavLink
            item={GET_STARTED_ITEM}
            isActive={activeItem === GET_STARTED_ITEM.id}
          />
          {/* Your agents section label */}
          <div className="h-8 flex items-center px-2 opacity-70">
            <span className="text-xs text-sidebar-foreground">Your agents</span>
          </div>
          {/* Your agents items */}
          <div className="space-y-1">
            {NAVIGATION_CONFIG[0].items.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                isActive={activeItem === item.id}
              />
            ))}
          </div>
        </div>

        {/* Other navigation groups */}
        {NAVIGATION_CONFIG.slice(1).map((group) => (
          <div key={group.label} className="p-2">
            <div className="h-8 flex items-center px-2 opacity-70">
              <span className="text-xs text-sidebar-foreground">
                {group.label}
              </span>
            </div>
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  item={item}
                  isActive={activeItem === item.id}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer navigation */}
      <div className="p-2 space-y-1">
        {FOOTER_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            isActive={activeItem === item.id}
          />
        ))}
      </div>

      {/* User profile section */}
      <div className="p-2">
        <div className="flex items-center gap-2 p-2">
          <div className="h-8 w-8 rounded-lg bg-sidebar-accent overflow-hidden">
            <div className="h-full w-full bg-gradient-to-br from-amber-200 to-orange-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-sidebar-foreground truncate">
              Jackson Wong
            </div>
            <div className="text-xs text-sidebar-foreground truncate">
              m@example.com
            </div>
          </div>
          <button className="p-1 hover:bg-sidebar-accent rounded">
            <MoreVertical className="h-4 w-4 text-sidebar-foreground" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function VM0Logo() {
  return (
    <svg
      width="82"
      height="20"
      viewBox="0 0 82 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 3D Cube icon */}
      <g>
        <path
          d="M10 2L2 6.5V15.5L10 20L18 15.5V6.5L10 2Z"
          fill="#FF6B35"
          stroke="#FF6B35"
          strokeWidth="1"
        />
        <path
          d="M10 2L2 6.5L10 11L18 6.5L10 2Z"
          fill="#FF8C5A"
        />
        <path
          d="M10 11V20L2 15.5V6.5L10 11Z"
          fill="#E85A2A"
        />
        <path
          d="M10 11V20L18 15.5V6.5L10 11Z"
          fill="#FF6B35"
        />
      </g>
      {/* VM0 text */}
      <text
        x="24"
        y="15"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="16"
        fontWeight="600"
        fill="#231f1b"
      >
        VM
      </text>
      <text
        x="52"
        y="15"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="16"
        fontWeight="600"
        fill="#FF6B35"
      >
        0
      </text>
    </svg>
  );
}
