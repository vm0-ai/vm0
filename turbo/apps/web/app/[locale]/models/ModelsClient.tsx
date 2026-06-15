"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "../../../navigation";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { MODELS, type ModelEntry, vendorIconPath } from "./data";

const MAX_WIDTH = 1200;
const PAGE_PADDING = 24;

type FilterKey = "all" | "reasoning" | "image" | "video";

const FILTER_LABEL_MAP: Record<FilterKey, string> = {
  all: "filterAll",
  reasoning: "filterReasoning",
  image: "filterImage",
  video: "filterVideo",
};

const FILTERS: {
  key: FilterKey;
  match: (m: ModelEntry) => boolean;
}[] = [
  {
    key: "all",
    match: () => {
      return true;
    },
  },
  {
    key: "reasoning",
    match: (m) => {
      return m.category === "reasoning";
    },
  },
  {
    key: "image",
    match: (m) => {
      return m.category === "image";
    },
  },
  {
    key: "video",
    match: (m) => {
      return m.category === "video";
    },
  },
];

function ModelCard({
  model,
  readMoreLabel,
  name,
  cardIntro,
}: {
  model: ModelEntry;
  readMoreLabel: string;
  name: string;
  cardIntro: string;
}) {
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
            {name}
          </Link>
        </h2>
      </header>

      <p className="mt-4 line-clamp-3 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
        {cardIntro}
      </p>

      <div className="mt-5">
        <Link
          href={`/models/${model.slug}`}
          className="inline-flex items-center gap-1 text-[14px] font-medium text-[#ed4e01] transition-all hover:gap-2"
        >
          {readMoreLabel}
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}

export function ModelsClient() {
  const t = useTranslations("models");
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
          <h1 className="hero-title">{t("heroTitle")}</h1>
          <p className="hero-description">{t("heroDescription")}</p>
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
            aria-label={t("filterAriaLabel")}
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
                  {t(FILTER_LABEL_MAP[filter.key])}
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
            const cn = `content.${model.slug}`;
            return (
              <ModelCard
                key={model.slug}
                model={model}
                readMoreLabel={t("readMoreAbout", { name: model.name })}
                name={t(`${cn}.name`)}
                cardIntro={t(`${cn}.cardIntro`)}
              />
            );
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
