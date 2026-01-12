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
      {/* Logo header - height: 49px, padding: 8px */}
      <div className="h-[49px] flex flex-col justify-center p-2 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 p-1.5 h-8">
          <img src="/logo_light.svg" alt="VM0" className="h-5 w-auto" />
          <span className="text-2xl font-medium leading-8 text-sidebar-foreground">
            Platform
          </span>
        </div>
      </div>

      {/* Main navigation area - gap: 8px between sections */}
      <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
        {/* Get started section */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <NavLink
              item={GET_STARTED_ITEM}
              isActive={activeItem === GET_STARTED_ITEM.id}
            />
          </div>
          {/* Your agents section label - height: 32px, px: 8px, opacity: 70% */}
          <div className="h-8 flex items-center px-2 opacity-70">
            <span className="text-xs leading-4 text-sidebar-foreground">
              Your agents
            </span>
          </div>
          {/* Your agents items - gap: 4px */}
          <div className="flex flex-col gap-1">
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
            {/* Section label - height: 32px, px: 8px, opacity: 70% */}
            <div className="h-8 flex items-center px-2 opacity-70">
              <span className="text-xs leading-4 text-sidebar-foreground">
                {group.label}
              </span>
            </div>
            {/* Menu items - gap: 4px */}
            <div className="flex flex-col gap-1">
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

      {/* Footer navigation - padding: 8px, gap: 4px */}
      <div className="p-2">
        <div className="flex flex-col gap-1">
          {FOOTER_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              isActive={activeItem === item.id}
            />
          ))}
        </div>
      </div>

      {/* User profile section - padding: 8px */}
      <div className="p-2">
        <div className="flex items-center gap-2 p-2 h-12">
          <div className="h-8 w-8 rounded-lg bg-sidebar-accent overflow-hidden">
            <div className="h-full w-full bg-gradient-to-br from-amber-200 to-orange-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm leading-5 text-sidebar-foreground truncate">
              Jackson Wong
            </div>
            <div className="text-xs leading-4 text-sidebar-foreground/70 truncate">
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

