import type { ReactNode } from "react";
import { Link } from "../../../navigation";
import type { DocsNavigationSection } from "../../lib/docs";

interface DocsShellProps {
  navigation: DocsNavigationSection[];
  homeLabel: string;
  activePath?: string;
  children: ReactNode;
}

export function DocsShell({
  navigation,
  homeLabel,
  activePath,
  children,
}: DocsShellProps) {
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar" aria-label="Documentation navigation">
        <Link
          href="/docs"
          className={`docs-nav-home${activePath ? "" : " active"}`}
        >
          {homeLabel}
        </Link>
        {navigation.map((section) => {
          return (
            <nav key={section.slug} className="docs-nav-section">
              <h2 className="docs-nav-heading">{section.title}</h2>
              <ul className="docs-nav-list">
                {section.pages.map((page) => {
                  return (
                    <li key={page.path}>
                      <Link
                        href={`/docs/${page.path}`}
                        className={`docs-nav-link${
                          activePath === page.path ? " active" : ""
                        }`}
                      >
                        {page.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          );
        })}
      </aside>
      <main className="docs-main">{children}</main>
    </div>
  );
}
