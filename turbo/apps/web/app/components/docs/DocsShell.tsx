import type { ReactNode } from "react";
import { Link } from "../../../navigation";
import type { DocsNavigationSection } from "../../lib/docs";
import { DocsSidebarScrollSync } from "./DocsSidebarScrollSync";

interface DocsShellProps {
  navigation: DocsNavigationSection[];
  homeLabel: string;
  activePath?: string;
  draft?: boolean;
  children: ReactNode;
}

function withDraft(href: string, draft?: boolean): string {
  return draft ? `${href}?status=draft` : href;
}

export function DocsShell({
  navigation,
  homeLabel,
  activePath,
  draft,
  children,
}: DocsShellProps) {
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar" aria-label="Documentation navigation">
        <DocsSidebarScrollSync activePath={activePath} />
        <Link
          href={withDraft("/docs", draft)}
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
                        href={withDraft(`/docs/${page.path}`, draft)}
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
