import { IconLayoutSidebar } from "@tabler/icons-react";
import { useSet } from "ccstate-react";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { navigateInReact$ } from "../../signals/route.ts";
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

  return (
    <header className="h-[49px] flex items-center border-b border-divider bg-background">
      {/* Left section: Sidebar toggle + Divider + Breadcrumb */}
      <div className="flex flex-1 items-center gap-2 px-4">
        <div className="flex items-center gap-2">
          {/* Sidebar toggle button - 28px container with 8px horizontal padding */}
          <button
            className="flex items-center justify-center size-7 px-2 hover:bg-muted rounded transition-colors"
            aria-label="Toggle sidebar"
          >
            <IconLayoutSidebar
              size={16}
              stroke={1.5}
              className="shrink-0 text-foreground"
            />
          </button>

          {/* Vertical divider - matching Figma's logo placeholder */}
          <div className="w-4 h-[17px] flex items-center justify-center">
            <div className="w-px h-4 bg-divider" />
          </div>
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
