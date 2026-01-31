import { IconLayoutSidebar } from "@tabler/icons-react";
import { useSet } from "ccstate-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { navigateInReact$ } from "../../signals/route.ts";
import { toggleSidebar$ } from "../../signals/sidebar.ts";
import type { RoutePath } from "../../types/route.ts";

export interface BreadcrumbItem {
  label: string;
  path?: RoutePath;
}

interface NavbarProps {
  breadcrumb: BreadcrumbItem[];
}

export function Navbar({ breadcrumb }: NavbarProps) {
  const navigate = useSet(navigateInReact$);
  const toggleSidebar = useSet(toggleSidebar$);

  return (
    <header className="h-[49px] flex items-center border-b border-divider bg-background">
      {/* Left section: Sidebar toggle + Divider + Breadcrumb */}
      <div className="flex flex-1 items-center gap-3 px-4">
        <div className="flex items-center gap-1">
          {/* Sidebar toggle button */}
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="icon-button"
                  aria-label="Toggle sidebar"
                  onClick={toggleSidebar}
                >
                  <IconLayoutSidebar
                    size={16}
                    className="shrink-0 text-foreground"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Toggle sidebar</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Vertical divider */}
          <div className="h-4 w-px bg-divider" />
        </div>

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5">
          {breadcrumb.map((item, index) => {
            const isLast = index === breadcrumb.length - 1;
            return (
              <div
                key={`${item.label}-${index}`}
                className="flex items-center gap-1.5"
              >
                {index > 0 && (
                  <span className="text-muted-foreground/50">/</span>
                )}
                {item.path ? (
                  <button
                    onClick={() => navigate(item.path!)}
                    className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {item.label}
                  </button>
                ) : (
                  <span
                    className={`text-sm font-medium ${isLast ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {item.label}
                  </span>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Right section: Theme toggle */}
      <div className="flex items-center gap-2 pr-6">
        <ThemeToggle />
      </div>
    </header>
  );
}
