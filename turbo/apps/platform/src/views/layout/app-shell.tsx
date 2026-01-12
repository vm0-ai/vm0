import type { ReactNode } from "react";
import { Sidebar } from "./sidebar.tsx";
import { Navbar } from "./navbar.tsx";
import { PageHeader } from "./page-header.tsx";

interface AppShellProps {
  breadcrumb: string[];
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function AppShell({
  breadcrumb,
  title,
  subtitle,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Navbar breadcrumb={breadcrumb} />
        <main className="flex-1 overflow-auto">
          <PageHeader title={title} subtitle={subtitle} />
          {children}
        </main>
      </div>
    </div>
  );
}
