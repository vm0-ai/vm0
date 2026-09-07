import { Input } from "@okouai/ui/components/ui/input";
import {
  ArrowRight,
  Check,
  Circle,
  MoreHorizontal,
  Search,
} from "lucide-react";

import { Label, Mono, Note, Page, Section, Stage } from "../chrome";
import { section } from "../manifest";

const RADII = [
  {
    token: "--radius-sm",
    className: "rounded-sm",
    note: "chips, inline marks",
  },
  { token: "--radius-md", className: "rounded-md", note: "menu items, rows" },
  { token: "--radius-lg", className: "rounded-lg", note: "buttons, inputs" },
  { token: "--radius-xl", className: "rounded-xl", note: "cards, dialogs" },
];

const STATES = [
  { token: "--color-state-hover", label: "hover" },
  { token: "--color-state-selected", label: "selected" },
  { token: "--color-state-selected-hover", label: "selected + hover" },
  { token: "--color-state-pressed", label: "pressed" },
];

export function ShapePage() {
  const shape = section("shape");
  const icon = section("icon");

  return (
    <Page
      title="Shape, focus & icons"
      lede="The geometry every control inherits: one radius ladder, one focus ring, one icon stroke."
    >
      <Section title="Radius">
        <Stage>
          <div className="flex flex-wrap gap-8">
            {RADII.map((entry) => {
              return (
                <div key={entry.token} className="flex flex-col gap-2">
                  <div
                    className={`size-16 bg-card border-[0.7px] border-[hsl(var(--gray-400))] ${entry.className}`}
                  />
                  <Mono>{entry.token}</Mono>
                  <Label>{entry.note}</Label>
                </div>
              );
            })}
          </div>
        </Stage>
        <div className="rounded-xl bg-muted/60 px-5 py-4">
          {shape.tokens.map((token) => {
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

      <Section
        title="Focus"
        blurb="The ring is the brand stop, chosen for contrast against the surface it lands on rather than for brand presence: 6.73:1 on the light canvas."
      >
        <Stage>
          <div className="flex max-w-sm flex-col gap-3">
            <Input placeholder="Click to focus" />
            <Note>
              Focus is a ring, never a colour change on the field itself — a
              filled field that recolours on focus reads as a validation state.
            </Note>
          </div>
        </Stage>
      </Section>

      <Section
        title="Interaction states"
        blurb="Translucent layers, so the same token reads with the same weight on any surface and reverses automatically in dark."
      >
        <Stage>
          <div className="flex flex-wrap gap-4">
            {STATES.map((state) => {
              return (
                <div key={state.token} className="flex flex-col gap-2">
                  <div
                    className="flex size-24 items-center justify-center rounded-lg bg-card"
                    style={{ background: `var(${state.token})` }}
                  />
                  <Label>{state.label}</Label>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {state.token.replace("--color-state-", "")}
                  </span>
                </div>
              );
            })}
          </div>
        </Stage>
      </Section>

      <Section
        title="Icons"
        blurb="Lucide, normalised to a 1.5 stroke. Lucide emits 2 when nothing overrides it, and 2 reads heavy beside 14px body text."
      >
        <Stage>
          <div className="flex items-center gap-6 text-foreground">
            <Search />
            <Check />
            <ArrowRight />
            <Circle />
            <MoreHorizontal />
          </div>
          <div className="mt-5 flex gap-6">
            {icon.tokens.map((token) => {
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
        </Stage>
      </Section>
    </Page>
  );
}
