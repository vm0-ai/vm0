import { IconLayoutSidebar } from "@tabler/icons-react";
import { ThemeToggle } from "../components/theme-toggle.tsx";

interface NavbarProps {
  breadcrumb: string[];
}

export function Navbar({ breadcrumb }: NavbarProps) {
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
          {breadcrumb.map((item, index) => (
            <div key={item} className="flex items-center gap-1.5">
              {index > 0 && <span className="text-muted-foreground/50">/</span>}
              <span className="text-sm font-medium text-secondary-foreground">
                {item}
              </span>
            </div>
          ))}
        </nav>
      </div>

      {/* Right section: Theme toggle */}
      <div className="flex items-center gap-2 pr-6">
        <ThemeToggle />
      </div>
    </header>
  );
}
