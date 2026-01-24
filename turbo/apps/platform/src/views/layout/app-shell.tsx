import type { ReactNode } from "react";
import { Sidebar } from "./sidebar.tsx";
import { Navbar } from "./navbar.tsx";
import { PageHeader } from "./page-header.tsx";

interface AppShellProps {
  breadcrumb: string[];
  title: string;
  subtitle?: string;
  children: ReactNode;
  gradientBackground?: boolean;
}

export function AppShell({
  breadcrumb,
  title,
  subtitle,
  children,
  gradientBackground,
}: AppShellProps) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Navbar breadcrumb={breadcrumb} />
        <main
          className="flex-1 overflow-auto"
          style={
            gradientBackground
              ? {
                  backgroundImage:
                    "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 1) 100%)",
                }
              : undefined
          }
        >
          <PageHeader title={title} subtitle={subtitle} />
          {children}
        </main>
      </div>
    </div>
  );
}
