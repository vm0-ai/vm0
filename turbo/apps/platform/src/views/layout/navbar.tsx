import { Menu } from "lucide-react";

interface NavbarProps {
  breadcrumb: string[];
}

export function Navbar({ breadcrumb }: NavbarProps) {
  return (
    <header className="h-[49px] flex items-center px-4 border-b border-sidebar-border bg-background">
      {/* Sidebar toggle - placeholder for mobile */}
      <button className="mr-2 p-1 rounded hover:bg-accent md:hidden">
        <Menu className="h-5 w-5" />
      </button>

      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        {breadcrumb.map((item, index) => (
          <span key={index} className="flex items-center gap-2">
            {index > 0 && <span className="text-muted-foreground/50">/</span>}
            <span>{item}</span>
          </span>
        ))}
      </nav>
    </header>
  );
}
