import { Button } from "@okouai/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { tokens } from "./manifest";
import { ColorPage } from "./pages/color";
import { ComponentsPage } from "./pages/components";
import { OverviewPage } from "./pages/overview";
import { ShapePage } from "./pages/shape";
import { ThemesPage } from "./pages/themes";
import { TypographyPage } from "./pages/typography";

type Theme = "light" | "dark";

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "color", label: "Colour" },
  { id: "typography", label: "Typography" },
  { id: "shape", label: "Shape & icons" },
  { id: "themes", label: "Workspace themes" },
  { id: "components", label: "Components" },
];

const NO_THEME = "none";

function currentPage() {
  const id = window.location.hash.replace("#", "");
  return PAGES.some((page) => {
    return page.id === id;
  })
    ? id
    : "overview";
}

export function App() {
  const [page, setPage] = useState(currentPage);
  const [theme, setTheme] = useState<Theme>("light");
  const [colorTheme, setColorTheme] = useState<string | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      return setPage(currentPage());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      return window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  // The colour-theme override is scoped to :root, so the catalogue has to
  // set it where the product does rather than on a preview container.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset["theme"] = theme;
    if (colorTheme) {
      root.dataset["gradientColorThemes"] = "";
      root.dataset["colorTheme"] = colorTheme;
    } else {
      delete root.dataset["gradientColorThemes"];
      delete root.dataset["colorTheme"];
    }
  }, [theme, colorTheme]);

  const navigate = (id: string) => {
    // pushState rather than assigning location.hash: the hash is only a
    // deep link into the catalogue, not a source of truth for what renders.
    window.history.pushState(null, "", `#${id}`);
    setPage(id);
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 bg-sidebar px-3 py-6">
        <div className="px-3 pb-6">
          <div className="text-sm font-semibold text-foreground">Okou</div>
          <div className="text-sm text-muted-foreground">Design system</div>
        </div>

        {PAGES.map((entry) => {
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                return navigate(entry.id);
              }}
              className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                page === entry.id
                  ? "bg-state-selected text-foreground"
                  : "text-muted-foreground hover:bg-state-hover hover:text-foreground"
              }`}
            >
              {entry.label}
            </button>
          );
        })}

        <div className="mt-auto flex flex-col gap-3 px-1">
          <Select
            value={colorTheme ?? NO_THEME}
            onValueChange={(next) => {
              return setColorTheme(next === NO_THEME ? null : String(next));
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_THEME}>No workspace theme</SelectItem>
              {tokens.colorThemes.map((entry) => {
                return (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              return setTheme(theme === "light" ? "dark" : "light");
            }}
          >
            {theme === "light" ? <Sun /> : <Moon />}
            {theme === "light" ? "Light" : "Dark"}
          </Button>
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        {page === "overview" ? <OverviewPage onNavigate={navigate} /> : null}
        {page === "color" ? <ColorPage theme={theme} /> : null}
        {page === "typography" ? <TypographyPage /> : null}
        {page === "shape" ? <ShapePage /> : null}
        {page === "themes" ? (
          <ThemesPage active={colorTheme} onSelect={setColorTheme} />
        ) : null}
        {page === "components" ? <ComponentsPage /> : null}
      </main>
    </div>
  );
}
