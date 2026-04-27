"use client";

import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { MODELS, type ModelEntry } from "./data";

const MAX_WIDTH = 880;
const PAGE_PADDING = 24;

function formatMultiplier(multiplier: number): string {
  return `×${multiplier}`;
}

function ModelCard({ model }: { model: ModelEntry }) {
  return (
    <article
      id={model.slug}
      className="overflow-hidden rounded-[20px] bg-white p-7 sm:p-8"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-[22px] font-medium leading-tight tracking-[-0.3px] text-[hsl(var(--foreground))] sm:text-[24px]">
          {model.name}
        </h2>
        <span className="inline-flex items-center rounded-md bg-[hsl(var(--gray-100))] px-2 py-0.5 text-[12px] font-medium text-[hsl(var(--muted-foreground))]">
          {formatMultiplier(model.multiplier)}
        </span>
        <span className="text-[13px] font-medium uppercase tracking-[1.2px] text-[hsl(var(--muted-foreground))]">
          {model.vendor}
        </span>
      </header>

      <p className="mt-4 text-[16px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
        {model.intro}
      </p>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
            Best for on VM0
          </h3>
          <ul className="mt-3 flex flex-col gap-2">
            {model.bestFor.map((tip) => {
              return (
                <li
                  key={tip}
                  className="flex items-start gap-2 text-[15px] font-light leading-relaxed text-[hsl(var(--foreground))]"
                >
                  <span
                    className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ed4e01]"
                    aria-hidden="true"
                  />
                  <span>{tip}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {model.avoidFor.length > 0 && (
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[hsl(var(--muted-foreground))]">
              Skip when
            </h3>
            <ul className="mt-3 flex flex-col gap-2">
              {model.avoidFor.map((tip) => {
                return (
                  <li
                    key={tip}
                    className="flex items-start gap-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]"
                  >
                    <span
                      className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--gray-300))]"
                      aria-hidden="true"
                    />
                    <span>{tip}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

export function ModelsClient() {
  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      {/* Hero */}
      <section className="hero-section" style={{ paddingBottom: 32 }}>
        <div className="container">
          <h1 className="hero-title">AI models on VM0</h1>
          <p className="hero-description">
            Every model available to your agents — what it&rsquo;s good at, and
            when to pick it.
          </p>
          <p
            className="text-[14px] text-[hsl(var(--muted-foreground))]"
            style={{ marginTop: 8 }}
          >
            Credit cost is shown relative to Claude Sonnet 4.6 (×1).
          </p>
        </div>
      </section>

      {/* Quick index */}
      <section style={{ paddingBottom: 32 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <nav className="flex flex-wrap gap-2" aria-label="Models">
            {MODELS.map((m) => {
              return (
                <a key={m.slug} href={`#${m.slug}`} className="uc-pill">
                  {m.name}
                  <span className="ml-2 text-[hsl(var(--muted-foreground))]">
                    {formatMultiplier(m.multiplier)}
                  </span>
                </a>
              );
            })}
          </nav>
        </div>
      </section>

      {/* Model cards */}
      <section style={{ paddingBottom: 120 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
          className="flex flex-col gap-5"
        >
          {MODELS.map((model) => {
            return <ModelCard key={model.slug} model={model} />;
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
