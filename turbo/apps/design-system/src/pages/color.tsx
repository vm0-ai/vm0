import { Label, Mono, Note, Page, Section } from "../chrome";
import type { TokenEntry, TokenSection } from "../manifest";
import { section, tokens } from "../manifest";

/**
 * Every swatch paints itself with the live custom property. The hex beside it
 * is resolved from source at build time, so if the two disagree the catalogue
 * is showing a resolution the stylesheet does not actually produce.
 */
function Swatch({
  token,
  theme,
}: {
  token: TokenEntry;
  theme: "light" | "dark";
}) {
  const hex = theme === "dark" ? token.darkHex : token.lightHex;
  const raw = theme === "dark" ? token.dark : token.light;
  const value = token.aliasOf ?? raw ?? "";
  const paint = value.startsWith("#")
    ? value
    : value.startsWith("hsl") || value.startsWith("color-mix")
      ? value
      : `hsl(var(${token.name}))`;

  return (
    <div className="flex items-center gap-3">
      <div
        className="size-10 shrink-0 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))]"
        style={{ background: paint }}
      />
      <div className="min-w-0">
        <div className="truncate font-mono text-[12px] text-foreground">
          {token.name}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {hex ?? raw ?? "—"}
        </div>
      </div>
    </div>
  );
}

function ValueRow({ token }: { token: TokenEntry }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="font-mono text-[12px] text-foreground">
        {token.name}
      </span>
      <span className="font-mono text-[12px] text-muted-foreground">
        {token.light}
      </span>
      {token.themed ? (
        <span className="font-mono text-[12px] text-brand-text">
          dark {token.dark}
        </span>
      ) : null}
    </div>
  );
}

function TokenGroup({
  data,
  theme,
}: {
  data: TokenSection;
  theme: "light" | "dark";
}) {
  const colors = data.tokens.filter((t) => {
    return t.kind === "color";
  });
  const values = data.tokens.filter((t) => {
    return t.kind !== "color";
  });
  const documented = data.tokens.filter((t) => {
    return t.comment;
  });

  return (
    <Section title={data.title} blurb={data.blurb}>
      {colors.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-6 gap-y-4">
          {colors.map((token) => {
            return <Swatch key={token.name} token={token} theme={theme} />;
          })}
        </div>
      ) : null}

      {values.length > 0 ? (
        <div className="rounded-xl bg-muted/60 px-5 py-4">
          {values.map((token) => {
            return <ValueRow key={token.name} token={token} />;
          })}
        </div>
      ) : null}

      {documented.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-[13px] text-muted-foreground hover:text-foreground">
            Why these values — {documented.length} of {data.tokens.length} carry
            reasoning in source
          </summary>
          <div className="mt-4 flex flex-col gap-4 rounded-xl bg-muted/60 px-5 py-4">
            {documented.map((token) => {
              return (
                <div key={token.name}>
                  <Mono>{token.name}</Mono>
                  <Note>{token.comment}</Note>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
    </Section>
  );
}

const COLOR_SECTIONS = [
  "brand",
  "neutral",
  "surface",
  "status",
  "state",
  "segment",
  "dataviz",
];

export function ColorPage({ theme }: { theme: "light" | "dark" }) {
  return (
    <Page
      title="Colour"
      lede={
        <>
          {tokens.totals.colors} colour tokens, {tokens.totals.themed} of which
          resolve differently in dark. Read in source order: the two primitive
          ramps first, then the semantic layer that components actually
          reference.
        </>
      }
    >
      <div className="flex gap-10">
        {tokens.sources.map((source) => {
          return (
            <div key={source.id} className="flex flex-col gap-1">
              <Label>{source.label}</Label>
              <span className="font-mono text-[12px] text-muted-foreground">
                {source.path}
              </span>
            </div>
          );
        })}
      </div>

      {COLOR_SECTIONS.map((id) => {
        return <TokenGroup key={id} data={section(id)} theme={theme} />;
      })}
    </Page>
  );
}
