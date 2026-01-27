import type { ReactNode } from "react";
import { Sidebar } from "./sidebar.tsx";
import { Navbar, type BreadcrumbItem } from "./navbar.tsx";
import { PageHeader } from "./page-header.tsx";

interface AppShellProps {
  breadcrumb: (string | BreadcrumbItem)[];
  title?: string;
  subtitle?: string;
  children: ReactNode;
  gradientBackground?: boolean;
}

/**
 * Normalize breadcrumb items to BreadcrumbItem format.
 * Accepts either strings or full BreadcrumbItem objects.
 */
function normalizeBreadcrumb(
  items: (string | BreadcrumbItem)[],
): BreadcrumbItem[] {
  return items.map((item) =>
    typeof item === "string" ? { label: item } : item,
  );
}

export function AppShell({
  breadcrumb,
  title,
  subtitle,
  children,
  gradientBackground,
}: AppShellProps) {
  const normalizedBreadcrumb = normalizeBreadcrumb(breadcrumb);

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Navbar breadcrumb={normalizedBreadcrumb} />
        <main
          className={`flex-1 overflow-auto ${gradientBackground ? "bg-background" : ""}`}
        >
          {title && <PageHeader title={title} subtitle={subtitle} />}
          {children}
        </main>
      </div>
    </div>
  );
}
