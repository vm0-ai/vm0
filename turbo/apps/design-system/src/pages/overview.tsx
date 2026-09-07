import { Label, Mono, Note, Page, Section, Stat } from "../chrome";
import { orphaned, undocumented } from "../coverage";
import { components, tokens } from "../manifest";

/**
 * Findings from mapping the catalogue against what production serves. Each one
 * is a place where the source of truth and the shipped product disagree, so
 * each is actionable rather than decorative.
 */
const DRIFT = [
  {
    title: "The base layer still names Noto Sans",
    detail:
      "packages/ui/styles/globals.css sets --font-family-sans to Noto Sans in @theme and again in its body rule. The platform layer overrides both to Geist, and production serves Geist — so the token file documents a typeface the product no longer uses.",
  },
  {
    title: "Its header still says VM0",
    detail:
      "The file opens with “VM0 Design System”, points at the VM0-Cloud Figma, and describes the brand as Amber #ffa500. The palette is current; the naming predates the rebrand to Okou, as does the zero-design-color.sites.vm0.io palette URL it cites.",
  },
  {
    title: "Two components ship outside the barrel",
    detail:
      "alert and sonner are not re-exported from @okouai/ui's index.ts, yet sonner is the most-imported component in the package. Call sites reach them through the ./components/ui/* subpath instead, so the barrel is not a reliable inventory — the file list is.",
  },
  {
    title: "Most UI still lives in the app, not the package",
    detail:
      "28 components ship in @okouai/ui. apps/platform/src/views holds 442 .tsx files, only 17 of them in the shared components/ directory. That gap is the real backlog: the catalogue can only cover what has been extracted.",
  },
];

export function OverviewPage({
  onNavigate,
}: {
  onNavigate: (id: string) => void;
}) {
  const missing = undocumented();
  const stale = orphaned();

  return (
    <Page
      title="Okou Design System"
      lede="One place for the tokens and components the product actually ships. Every value on these pages is read from the same stylesheets the app loads, and every component is the real import — so this cannot drift from the product without the build noticing."
    >
      <Section title="What is here">
        <div className="flex flex-wrap gap-12 rounded-xl bg-muted/60 px-6 py-6">
          <Stat value={tokens.totals.tokens} label="design tokens" />
          <Stat value={tokens.totals.colors} label="colour tokens" />
          <Stat
            value={tokens.totals.themed}
            label="resolve differently in dark"
          />
          <Stat value={components.totals.files} label="components" />
          <Stat value={tokens.colorThemes.length} label="workspace themes" />
        </div>
      </Section>

      <Section
        title="How it stays in sync"
        blurb="The catalogue reads its content out of the source rather than restating it."
      >
        <div className="flex flex-col gap-5 rounded-xl bg-muted/60 px-6 py-6">
          <div>
            <Label>Tokens</Label>
            <Note>
              pnpm generate parses both stylesheets and writes the manifest
              these pages render. A token added to either file appears here on
              the next build, carrying the comment that documents it.
            </Note>
            {tokens.sources.map((source) => {
              return (
                <div key={source.id} className="mt-2">
                  <Mono>{source.path}</Mono>
                </div>
              );
            })}
          </div>
          <div>
            <Label>Components</Label>
            <Note>
              The variant matrices are read from each component&rsquo;s own cva
              map, so a new variant renders itself. What a generator cannot
              invent is a meaningful demo, so those are written by hand — and a
              test fails the build when a component ships without one.
            </Note>
          </div>
          <div>
            <Label>Styling</Label>
            <Note>
              This app imports the platform stylesheet directly. That file
              already pulls in Tailwind and the @okouai/ui token layer in order,
              so the catalogue renders under the exact cascade the product
              ships.
            </Note>
          </div>
        </div>

        {missing.length > 0 || stale.length > 0 ? (
          <div className="rounded-xl bg-brand-subtle px-6 py-5">
            <Label>Coverage gap</Label>
            <Note>
              {missing.length > 0 ? `No demo yet: ${missing.join(", ")}.` : ""}
              {stale.length > 0
                ? `Demo without a component: ${stale.join(", ")}.`
                : ""}
            </Note>
          </div>
        ) : (
          <Note>
            {`Every one of the ${components.totals.files} components has a demo, and pnpm test enforces it.`}
          </Note>
        )}
      </Section>

      <Section
        title="Where source and product disagree"
        blurb="Found while mapping this catalogue against the CSS production currently serves. None of these change how the app looks today; all of them mislead the next person reading the token file."
      >
        <div className="flex flex-col gap-6">
          {DRIFT.map((item) => {
            return (
              <div
                key={item.title}
                className="rounded-xl bg-muted/60 px-6 py-5"
              >
                <h3 className="text-sm font-semibold text-foreground">
                  {item.title}
                </h3>
                <Note>{item.detail}</Note>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Start here">
        <div className="flex flex-wrap gap-3">
          {[
            { id: "color", label: "Colour" },
            { id: "typography", label: "Typography" },
            { id: "shape", label: "Shape & icons" },
            { id: "themes", label: "Workspace themes" },
            { id: "components", label: "Components" },
          ].map((link) => {
            return (
              <button
                key={link.id}
                type="button"
                onClick={() => {
                  return onNavigate(link.id);
                }}
                className="rounded-lg bg-card px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-card-hover"
              >
                {link.label}
              </button>
            );
          })}
        </div>
      </Section>
    </Page>
  );
}
