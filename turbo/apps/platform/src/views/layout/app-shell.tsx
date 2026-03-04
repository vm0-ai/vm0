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
  /** Optional class for wrapping title + children (e.g. max-width and centering) */
  contentClassName?: string;
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
  contentClassName,
}: AppShellProps) {
  const normalizedBreadcrumb = normalizeBreadcrumb(breadcrumb);

  const mainContent = (
    <>
      {title && <PageHeader title={title} subtitle={subtitle} />}
      {children}
    </>
  );

  return (
    <div className="flex h-dvh">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <Navbar breadcrumb={normalizedBreadcrumb} />
        <main
          className={`flex-1 overflow-auto ${gradientBackground ? "bg-background" : ""}`}
        >
          {contentClassName ? (
            <div className={contentClassName}>{mainContent}</div>
          ) : (
            mainContent
          )}
        </main>
      </div>
    </div>
  );
}
