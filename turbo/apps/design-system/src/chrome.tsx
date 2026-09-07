import type { ReactNode } from "react";

/**
 * The catalogue's own furniture. It is built from the product's tokens rather
 * than a separate look, so a broken token shows up as a broken catalogue.
 */

export function Page({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl px-8 pb-32 pt-6">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      {lede ? (
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          {lede}
        </p>
      ) : null}
      <div className="mt-10 flex flex-col gap-14">{children}</div>
    </div>
  );
}

export function Section({
  title,
  blurb,
  aside,
  children,
}: {
  title: string;
  blurb?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {blurb ? (
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
              {blurb}
            </p>
          ) : null}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/**
 * A recessed field that holds live components. Demos sit on the page surface
 * rather than a card, because a card would put every demo on a background the
 * product does not always give it.
 */
export function Stage({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl bg-muted/60 p-6 ${className}`}
      style={{ containerType: "inline-size" }}
    >
      {children}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
      {children}
    </code>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="whitespace-pre-line text-[13px] leading-6 text-muted-foreground">
      {children}
    </p>
  );
}

/** A short fact with its label above it, for header strips. */
export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <Label>{label}</Label>
    </div>
  );
}
