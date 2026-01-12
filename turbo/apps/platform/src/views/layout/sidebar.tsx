import { useGet } from "ccstate-react";
import {
  NAVIGATION_CONFIG,
  FOOTER_NAV_ITEMS,
  activeNavItem$,
} from "../../signals/layout/navigation.ts";
import { NavLink } from "./nav-link.tsx";

export function Sidebar() {
  const activeItem = useGet(activeNavItem$);

  return (
    <aside className="hidden md:flex w-[255px] flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo header */}
      <div className="h-[49px] flex items-center px-4 border-b border-sidebar-border">
        <span className="font-semibold text-sidebar-foreground">
          VM0 Platform
        </span>
      </div>

      {/* Navigation groups */}
      <nav className="flex-1 overflow-y-auto p-2">
        {NAVIGATION_CONFIG.map((group) => (
          <div key={group.label} className="mb-4">
            <span className="px-3 text-xs text-sidebar-foreground/70 uppercase tracking-wider">
              {group.label}
            </span>
            <div className="mt-1 space-y-1">
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
      </nav>

      {/* Footer navigation */}
      <div className="border-t border-sidebar-border p-2">
        {FOOTER_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            isActive={activeItem === item.id}
          />
        ))}
      </div>

      {/* User profile section - placeholder */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-sidebar-accent" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-sidebar-foreground truncate">
              User Name
            </div>
            <div className="text-xs text-sidebar-foreground/60 truncate">
              email@example.com
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
