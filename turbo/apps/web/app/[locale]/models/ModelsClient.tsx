"use client";

import { useMemo, useState } from "react";
import { Link } from "../../../navigation";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { MODELS, type ModelEntry, vendorIconPath } from "./data";

const MAX_WIDTH = 1200;
const PAGE_PADDING = 24;

type FilterKey = "all" | "recommended" | "multimodal" | "cost-saving";

const FILTERS: {
  key: FilterKey;
  label: string;
  match: (m: ModelEntry) => boolean;
}[] = [
  {
    key: "all",
    label: "All",
    match: () => {
      return true;
    },
  },
  {
    key: "recommended",
    label: "Recommended",
    match: (m) => {
      return m.vm0Tier === "core";
    },
  },
  {
    key: "multimodal",
    label: "Multimodal",
    match: (m) => {
      return m.modalities.some((mod) => {
        return ["Vision", "Image", "Video"].includes(mod);
      });
    },
  },
  {
    key: "cost-saving",
    label: "Cost-saving",
    match: (m) => {
      return m.vm0Tier === "cost-saving";
    },
  },
];

function ModelCard({ model }: { model: ModelEntry }) {
  const iconPath = vendorIconPath(model.vendor);
  return (
    <article
      id={model.slug}
      className="overflow-hidden rounded-[20px] bg-white p-6 sm:p-7"
    >
      <header className="flex items-center gap-3">
        {iconPath && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={iconPath}
            alt=""
            width={28}
            height={28}
            className="shrink-0 rounded-md"
          />
        )}
        <h2 className="text-[22px] font-medium leading-tight tracking-[-0.3px] text-[hsl(var(--foreground))]">
          <Link
            href={`/models/${model.slug}`}
            className="text-[hsl(var(--foreground))] hover:text-[#ed4e01]"
          >
            {model.name}
          </Link>
        </h2>
      </header>

      <p className="mt-4 line-clamp-3 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
        {model.cardIntro}
      </p>

      <div className="mt-5">
        <Link
          href={`/models/${model.slug}`}
          className="inline-flex items-center gap-1 text-[14px] font-medium text-[#ed4e01] transition-all hover:gap-2"
        >
          Read more about {model.name}
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}

export function ModelsClient() {
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  const visibleModels = useMemo(() => {
    const filter = FILTERS.find((f) => {
      return f.key === activeFilter;
    });
    if (!filter) return MODELS;
    return MODELS.filter(filter.match);
  }, [activeFilter]);

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      {/* Hero */}
      <section className="hero-section" style={{ paddingBottom: 32 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <h1 className="hero-title">AI models on VM0</h1>
          <p className="hero-description">
            Every model available to your agents. What it&rsquo;s good at, and
            when to pick it.
          </p>
        </div>
      </section>

      {/* Filter pills */}
      <section style={{ paddingBottom: 32 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <div
            className="flex flex-wrap gap-2"
            role="tablist"
            aria-label="Filter models"
          >
            {FILTERS.map((filter) => {
              const isActive = activeFilter === filter.key;
              return (
                <button
                  key={filter.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`uc-pill${isActive ? " uc-pill--active" : ""}`}
                  onClick={() => {
                    setActiveFilter(filter.key);
                  }}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
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
          className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 lg:grid-cols-3"
        >
          {visibleModels.map((model) => {
            return <ModelCard key={model.slug} model={model} />;
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
