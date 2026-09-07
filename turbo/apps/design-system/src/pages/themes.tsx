import { Button } from "@okouai/ui/components/ui/button";
import { Check } from "lucide-react";

import { Label, Mono, Note, Page, Section, Stage } from "../chrome";
import { tokens } from "../manifest";

const RAMP = [
  "--gray-0",
  "--gray-50",
  "--gray-100",
  "--gray-200",
  "--gray-300",
  "--gray-400",
  "--gray-500",
];

const SURFACES = [
  { token: "--background", label: "page" },
  { token: "--sidebar", label: "sidebar" },
  { token: "--card", label: "card" },
  { token: "--popover", label: "popover" },
  { token: "--accent", label: "accent" },
  { token: "--ring", label: "ring" },
];

export function ThemesPage({
  active,
  onSelect,
}: {
  active: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <Page
      title="Workspace themes"
      lede="Eight themes the user picks from in the product. A theme does not recolour the brand — it re-hues the neutral ramp underneath it, so chrome takes on a cast while Amber, Coral and every semantic pairing stay exactly where they were."
    >
      <Section
        title="The eight"
        blurb="Each theme pairs one anchor with one companion. The same pair drives the picker swatch and the workspace ambience."
        aside={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return onSelect(null);
            }}
            disabled={active === null}
          >
            Clear
          </Button>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4">
          {tokens.colorThemes.map((theme) => {
            const selected = theme.id === active;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => {
                  return onSelect(selected ? null : theme.id);
                }}
                className={`flex flex-col gap-3 rounded-xl p-4 text-left transition-colors ${
                  selected
                    ? "bg-state-selected"
                    : "bg-muted/60 hover:bg-state-hover"
                }`}
              >
                <div
                  className="h-14 w-full rounded-lg"
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${theme.anchor} 0%, ${theme.companion} 100%)`,
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {theme.label}
                  </span>
                  {selected ? (
                    <Check className="size-4 text-brand-text" />
                  ) : null}
                </div>
                <div className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
                  <span>{theme.anchor}</span>
                  <span>{theme.companion}</span>
                  <span>hue {theme.hue}</span>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="What a theme moves"
        blurb={
          active
            ? `Live, with ${active} applied to the document. Every swatch below is painted by the same custom property the product reads.`
            : "Pick a theme above to see these swatches move. With no theme selected the neutral ramp is the untinted default."
        }
      >
        <Stage>
          <Label>Neutral ramp</Label>
          <div className="mt-2 flex overflow-hidden rounded-lg">
            {RAMP.map((token) => {
              return (
                <div
                  key={token}
                  className="h-14 flex-1"
                  style={{ background: `hsl(var(${token}))` }}
                  title={token}
                />
              );
            })}
          </div>

          <Label>Semantic surfaces</Label>
          <div className="mt-2 flex flex-wrap gap-4">
            {SURFACES.map((surface) => {
              return (
                <div key={surface.token} className="flex flex-col gap-1.5">
                  <div
                    className="size-16 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))]"
                    style={{ background: `hsl(var(${surface.token}))` }}
                  />
                  <Label>{surface.label}</Label>
                </div>
              );
            })}
          </div>
        </Stage>

        <Note>
          {`The override lands on :root[data-gradient-color-themes][data-color-theme] and redeclares ${tokens.colorThemeOverrides.light.length} properties in light and ${tokens.colorThemeOverrides.dark.length} in dark. That is why these names appear twice across the two stylesheets: the second declaration is the theme, not a duplicate.`}
        </Note>
      </Section>

      <Section title="Overridden by a theme">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-6 gap-y-1 rounded-xl bg-muted/60 px-5 py-4">
          {tokens.colorThemeOverrides.light.map((name) => {
            return <Mono key={name}>{name}</Mono>;
          })}
        </div>
      </Section>
    </Page>
  );
}
