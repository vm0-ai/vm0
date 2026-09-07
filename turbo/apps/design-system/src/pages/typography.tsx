import { Label, Mono, Note, Page, Section } from "../chrome";
import { section } from "../manifest";

const SPECIMEN = [
  { className: "text-3xl font-semibold tracking-tight", label: "Display" },
  { className: "text-2xl font-semibold", label: "Page title" },
  { className: "text-lg font-semibold", label: "Section title" },
  { className: "text-base font-medium", label: "Emphasis" },
  { className: "text-sm", label: "Body — the product's default" },
  { className: "text-sm text-muted-foreground", label: "Body muted" },
  { className: "text-xs text-muted-foreground", label: "Caption" },
];

const WEIGHTS = [400, 500, 600, 700];

export function TypographyPage() {
  const type = section("type");
  const families = type.tokens.filter((t) => {
    return t.name.startsWith("--font-family");
  });
  const sizes = type.tokens.filter((t) => {
    return !t.name.startsWith("--font-family");
  });

  return (
    <Page
      title="Typography"
      lede="Geist for interface text, Geist Mono for code and identifiers. The families are set by the platform layer, which is the layer the product loads last."
    >
      <Section title="Families">
        <div className="flex flex-col gap-5 rounded-xl bg-muted/60 px-6 py-5">
          {families.map((token) => {
            return (
              <div key={token.name} className="flex flex-col gap-1">
                <Mono>{token.name}</Mono>
                <span className="font-mono text-[12px] text-muted-foreground">
                  {token.light}
                </span>
              </div>
            );
          })}
        </div>
        <Note>
          {
            "@okouai/ui/styles/globals.css still names Noto Sans in its own @theme block and in the body rule. The platform layer overrides both, so the product renders Geist — but a surface that loads the base layer alone would not."
          }
        </Note>
      </Section>

      <Section
        title="Scale"
        blurb="What the interface actually sets. Body is 14px: the product is dense, and 16px body pushes every row height up with it."
      >
        <div className="flex flex-col gap-6 rounded-xl bg-muted/60 px-6 py-6">
          {SPECIMEN.map((entry) => {
            return (
              <div key={entry.label} className="flex flex-col gap-1.5">
                <Label>{entry.label}</Label>
                <p className={entry.className}>
                  Agents that finish the work, not just the chat
                </p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Weights">
        <div className="flex flex-wrap gap-8 rounded-xl bg-muted/60 px-6 py-6">
          {WEIGHTS.map((weight) => {
            return (
              <div key={weight} className="flex flex-col gap-1.5">
                <Label>{weight}</Label>
                <p className="text-lg" style={{ fontWeight: weight }}>
                  Okou
                </p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Figma-derived steps"
        blurb="Named sizes and line heights carried over from the design file. Everything else uses Tailwind's own scale."
      >
        <div className="rounded-xl bg-muted/60 px-5 py-4">
          {sizes.map((token) => {
            return (
              <div key={token.name} className="flex items-baseline gap-3 py-1">
                <span className="font-mono text-[12px] text-foreground">
                  {token.name}
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">
                  {token.light}
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Mono">
        <div className="rounded-xl bg-muted/60 px-6 py-5">
          <pre className="overflow-x-auto font-mono text-[13px] leading-6 text-foreground">
            {`const run = await okou.runs.create({\n  agentId: "agt_7f3c",\n  prompt: "Summarise this week's inbound",\n});`}
          </pre>
        </div>
      </Section>
    </Page>
  );
}
