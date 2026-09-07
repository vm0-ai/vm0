import { Button } from "@okouai/ui/components/ui/button";
import {
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui/components/ui/segment-control";
import { Play } from "lucide-react";
import type { ReactNode } from "react";

import { Label, Mono, Note, Page, Section, Stage } from "../chrome";
import { DEMOS } from "../demos";
import type { ComponentEntry } from "../manifest";
import { components } from "../manifest";

/**
 * A component's variants are read from its own cva map, then rendered here
 * exhaustively. Adding a variant to the component adds a cell to this grid;
 * nothing in the catalogue has to be told about it.
 */
const VARIANT_RENDERERS: Record<
  string,
  Record<string, (value: string) => ReactNode>
> = {
  button: {
    variant: (value) => {
      return (
        <Button variant={value as never}>
          {value === "link" ? "Link" : "Button"}
        </Button>
      );
    },
    size: (value) => {
      return value.startsWith("icon") ? (
        <Button size={value as never} variant="outline" aria-label={value}>
          <Play />
        </Button>
      ) : (
        <Button size={value as never} variant="outline">
          {value}
        </Button>
      );
    },
    iconSize: (value) => {
      return (
        <Button
          size="icon"
          variant="outline"
          iconSize={value as never}
          aria-label={value}
        >
          <Play />
        </Button>
      );
    },
  },
  "segment-control": {
    variant: (value) => {
      return (
        <SegmentControl variant={value as never} defaultValue="a">
          <SegmentControlItem value="a">One</SegmentControlItem>
          <SegmentControlItem value="b">Two</SegmentControlItem>
        </SegmentControl>
      );
    },
    size: (value) => {
      return (
        <SegmentControl size={value as never} defaultValue="a">
          <SegmentControlItem value="a">One</SegmentControlItem>
          <SegmentControlItem value="b">Two</SegmentControlItem>
        </SegmentControl>
      );
    },
  },
};

function VariantMatrix({ entry }: { entry: ComponentEntry }) {
  const groups = Object.entries(entry.variants);
  if (groups.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {groups.map(([group, values]) => {
        const renderer = VARIANT_RENDERERS[entry.id]?.[group];
        return (
          <div key={group} className="flex flex-col gap-3">
            <Label>{group}</Label>
            {renderer ? (
              <div className="flex flex-wrap items-end gap-4">
                {values.map((value) => {
                  return (
                    <div
                      key={value}
                      className="flex flex-col items-start gap-1.5"
                    >
                      {renderer(value)}
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {value}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {values.map((value) => {
                  return <Mono key={value}>{value}</Mono>;
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ComponentBlock({ entry }: { entry: ComponentEntry }) {
  const demo = DEMOS.find((d) => {
    return d.id === entry.id;
  });

  return (
    <Section
      title={demo?.title ?? entry.id}
      blurb={demo?.usage}
      aside={
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          <span className="font-mono text-[11px] text-muted-foreground">
            {entry.module.replace("./", "@okouai/ui/")}
          </span>
          {entry.usesBaseUi ? <Label>Base UI</Label> : null}
        </div>
      }
    >
      <Stage>
        <div className="flex flex-col gap-8">
          {demo ? <demo.Demo /> : null}
          <VariantMatrix entry={entry} />
        </div>
      </Stage>

      {entry.exports.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {entry.exports.map((name) => {
            return <Mono key={name}>{name}</Mono>;
          })}
        </div>
      ) : (
        <Note>
          {
            "Not re-exported from @okouai/ui's barrel — call sites deep-import it."
          }
        </Note>
      )}

      {entry.doc ? <Note>{entry.doc}</Note> : null}
    </Section>
  );
}

export function ComponentsPage() {
  // Demo order, not file order: button carries the most of the system and
  // belongs at the top, where an alphabetical list puts alert.
  const documented = DEMOS.map((demo) => {
    return components.components.find((entry) => {
      return entry.id === demo.id;
    });
  }).filter((entry) => {
    return entry !== undefined;
  });

  return (
    <Page
      title="Components"
      lede={`${components.totals.files} components ship in @okouai/ui. Each block below imports the real component and the real stylesheet — nothing here is a copy.`}
    >
      {documented.map((entry) => {
        return <ComponentBlock key={entry.id} entry={entry} />;
      })}
    </Page>
  );
}
