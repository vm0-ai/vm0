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

function variantCount(entry: ComponentEntry) {
  return Object.values(entry.variants).reduce((total, values) => {
    return total + values.length;
  }, 0);
}

function ComponentDetail({ entry }: { entry: ComponentEntry }) {
  const demo = DEMOS.find((d) => {
    return d.id === entry.id;
  });

  return (
    <Page title={demo?.title ?? entry.id} lede={demo?.usage}>
      <Section title="Live">
        <Stage>
          <div className="flex flex-col gap-8">
            {demo ? <demo.Demo /> : null}
            <VariantMatrix entry={entry} />
          </div>
        </Stage>
      </Section>

      <Section title="Import">
        <div className="flex flex-col gap-3 rounded-xl bg-muted/60 px-5 py-4">
          <Mono>{`import { ${entry.exports[0] ?? "…"} } from "@okouai/ui${entry.module.replace(".", "")}";`}</Mono>
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
          {entry.types.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {entry.types.map((name) => {
                return <Mono key={name}>{name}</Mono>;
              })}
            </div>
          ) : null}
          {entry.usesBaseUi ? <Label>Built on Base UI</Label> : null}
        </div>
      </Section>

      {entry.doc ? (
        <Section title="From the source">
          <Note>{entry.doc}</Note>
        </Section>
      ) : null}
    </Page>
  );
}

function ComponentIndex({
  onNavigate,
}: {
  onNavigate: (route: string) => void;
}) {
  return (
    <Page
      title="Components"
      lede={`${components.totals.files} components ship in @okouai/ui. Each one opens on its own page, rendering the real component under the real stylesheet — nothing here is a copy.`}
    >
      <Section title="All components">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
          {DEMOS.map((demo) => {
            const entry = components.components.find((candidate) => {
              return candidate.id === demo.id;
            });
            if (!entry) return null;
            const variants = variantCount(entry);
            return (
              <button
                key={demo.id}
                type="button"
                onClick={() => {
                  return onNavigate(`components/${demo.id}`);
                }}
                className="flex flex-col gap-1.5 rounded-xl bg-muted/60 px-4 py-3.5 text-left transition-colors hover:bg-state-hover"
              >
                <span className="text-sm font-medium text-foreground">
                  {demo.title}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {entry.file}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {entry.exports.length > 0
                    ? `${String(entry.exports.length)} exports`
                    : "deep import only"}
                  {variants > 0 ? ` · ${String(variants)} variants` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </Section>
    </Page>
  );
}

export function ComponentsPage({
  componentId,
  onNavigate,
}: {
  componentId: string | null;
  onNavigate: (route: string) => void;
}) {
  const entry = components.components.find((candidate) => {
    return candidate.id === componentId;
  });

  if (!entry) return <ComponentIndex onNavigate={onNavigate} />;
  return <ComponentDetail entry={entry} />;
}
