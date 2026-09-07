import { Button } from "@okouai/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { components, tokens } from "./manifest";
import { ColorPage } from "./pages/color";
import { ComponentsPage } from "./pages/components";
import { OverviewPage } from "./pages/overview";
import { ShapePage } from "./pages/shape";
import { ThemesPage } from "./pages/themes";
import { TypographyPage } from "./pages/typography";
import { DEMOS } from "./demos";

type Theme = "light" | "dark";

const FOUNDATIONS = [
  { id: "overview", label: "Overview" },
  { id: "color", label: "Colour" },
  { id: "typography", label: "Typography" },
  { id: "shape", label: "Shape & icons" },
  { id: "themes", label: "Workspace themes" },
];

const NO_THEME = "none";

/**
 * Component routes are `components/<file-name>`, which keeps a deep link to one
 * component stable across renames of its display title.
 */
const COMPONENT_ROUTES = DEMOS.map((demo) => {
  return {
    id: `components/${demo.id}`,
    label: demo.title,
    componentId: demo.id,
  };
});

const ROUTES = new Set([
  ...FOUNDATIONS.map((entry) => {
    return entry.id;
  }),
  "components",
  ...COMPONENT_ROUTES.map((entry) => {
    return entry.id;
  }),
]);

function currentRoute() {
  const id = window.location.hash.replace("#", "");
  return ROUTES.has(id) ? id : "overview";
}

function NavButton({
  active,
  label,
  indent = false,
  onClick,
}: {
  active: boolean;
  label: string;
  indent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-lg py-2 text-left text-sm transition-colors ${
        indent ? "pl-6 pr-3" : "px-3"
      } ${
        active
          ? "bg-state-selected text-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [theme, setTheme] = useState<Theme>("light");
  const [colorTheme, setColorTheme] = useState<string | null>(null);
  const scrollport = useRef<HTMLElement>(null);

  useEffect(() => {
    const onHashChange = () => {
      return setRoute(currentRoute());
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

  // The product's stylesheet locks html/body/#root to the viewport, so the
  // page never scrolls -- main is the scrollport, and a new route has to be
  // returned to its top by hand.
  useEffect(() => {
    scrollport.current?.scrollTo({ top: 0 });
  }, [route]);

  const navigate = (id: string) => {
    // pushState rather than assigning location.hash: the hash is only a
    // deep link into the catalogue, not a source of truth for what renders.
    window.history.pushState(null, "", `#${id}`);
    setRoute(id);
  };

  const componentRoute = COMPONENT_ROUTES.find((entry) => {
    return entry.id === route;
  });

  return (
    <div className="flex h-full bg-background text-foreground">
      <nav className="flex h-full w-60 shrink-0 flex-col bg-sidebar">
        <div className="shrink-0 px-6 pb-5 pt-6">
          <div className="text-sm font-semibold text-foreground">Okou</div>
          <div className="text-sm text-muted-foreground">Design system</div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
          {FOUNDATIONS.map((entry) => {
            return (
              <NavButton
                key={entry.id}
                active={route === entry.id}
                label={entry.label}
                onClick={() => {
                  return navigate(entry.id);
                }}
              />
            );
          })}

          <NavButton
            active={route === "components"}
            label={`Components · ${String(components.totals.files)}`}
            onClick={() => {
              return navigate("components");
            }}
          />

          {COMPONENT_ROUTES.map((entry) => {
            return (
              <NavButton
                key={entry.id}
                active={route === entry.id}
                label={entry.label}
                indent
                onClick={() => {
                  return navigate(entry.id);
                }}
              />
            );
          })}
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-end gap-3 px-8 pt-6">
          <Select
            value={colorTheme ?? NO_THEME}
            onValueChange={(next) => {
              return setColorTheme(next === NO_THEME ? null : String(next));
            }}
          >
            <SelectTrigger className="w-52">
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
            size="icon"
            showTooltip
            aria-label={
              theme === "light" ? "Switch to dark" : "Switch to light"
            }
            onClick={() => {
              return setTheme(theme === "light" ? "dark" : "light");
            }}
          >
            {theme === "light" ? <Sun /> : <Moon />}
          </Button>
        </header>

        <main ref={scrollport} className="min-w-0 flex-1 overflow-y-auto">
          {route === "overview" ? <OverviewPage onNavigate={navigate} /> : null}
          {route === "color" ? <ColorPage theme={theme} /> : null}
          {route === "typography" ? <TypographyPage /> : null}
          {route === "shape" ? <ShapePage /> : null}
          {route === "themes" ? (
            <ThemesPage active={colorTheme} onSelect={setColorTheme} />
          ) : null}
          {route === "components" || componentRoute ? (
            <ComponentsPage
              componentId={componentRoute?.componentId ?? null}
              onNavigate={navigate}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}
