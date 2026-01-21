import { IconLayoutSidebar } from "@tabler/icons-react";

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
            className="flex items-center justify-center size-7 px-2 hover:bg-accent rounded transition-colors"
            aria-label="Toggle sidebar"
          >
            <IconLayoutSidebar size={16} className="shrink-0 text-foreground" />
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

      {/* Right section: Join Discord button - pr-6 (24px) to match Figma */}
      <div className="pr-6">
        <button className="inline-flex items-center gap-2 h-9 px-2.5 rounded-lg hover:bg-accent/50 transition-colors">
          <span className="flex items-center shrink-0 size-[18px]">
            <img
              src="/discord-icon.svg"
              alt="Discord"
              width={18}
              height={18}
              className="block"
            />
          </span>
          <span className="flex items-center text-sm font-medium leading-5 text-foreground whitespace-nowrap">
            Join Discord
          </span>
        </button>
      </div>
    </header>
  );
}
