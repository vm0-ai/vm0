"use client";

import { useState } from "react";
import Image from "next/image";
import { IconArrowUpRight } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { Link } from "../../../../navigation";
import { Footer } from "../../../components/Footer";
import { Particles } from "../../../components/Particles";
import { getAppUrl } from "../../../../src/lib/zero/url";
import { buildPromptHref } from "../data";
import type { UseCase, ConnectorRef } from "../data";

interface PromptVariant {
  label: string;
  prompt: string;
}

function ConnectorBadge({ connector }: { connector: ConnectorRef }) {
  if (!connector.icon) return null;
  return (
    <span
      className="uc-connector-badge overflow-hidden"
      title={connector.label}
    >
      <Image
        src={connector.icon}
        alt={connector.label}
        width={20}
        height={20}
        className={`uc-connector-icon${connector.dark ? " landing-icon-invert" : ""}${connector.looseViewBox ? " scale-[2.2]" : ""}`}
      />
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="uc-section">
      <h2 className="uc-section-title" style={{ marginBottom: 16 }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function ScreenshotCarousel({
  screenshots,
  alt,
}: {
  screenshots: string[];
  alt: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const showControls = screenshots.length > 1;

  return (
    <div className="uc-carousel">
      <div className="uc-screenshot-frame">
        <Image
          src={screenshots[activeIndex]!}
          alt={`${alt} — screenshot ${activeIndex + 1}`}
          width={800}
          height={450}
          className="uc-screenshot-img"
          priority
        />
      </div>
      {showControls && (
        <>
          <button
            className="uc-carousel-btn uc-carousel-btn--left"
            onClick={() => {
              setActiveIndex(
                (activeIndex - 1 + screenshots.length) % screenshots.length,
              );
            }}
            aria-label="Previous screenshot"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M10 12L6 8L10 4"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="uc-carousel-btn uc-carousel-btn--right"
            onClick={() => {
              setActiveIndex((activeIndex + 1) % screenshots.length);
            }}
            aria-label="Next screenshot"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M6 4L10 8L6 12"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className="uc-carousel-dots">
            {screenshots.map((_, i) => {
              return (
                <button
                  key={i}
                  className={`uc-carousel-dot${i === activeIndex ? " uc-carousel-dot--active" : ""}`}
                  onClick={() => {
                    setActiveIndex(i);
                  }}
                  aria-label={`Go to screenshot ${i + 1}`}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function TryItLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-4 flex justify-start">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-full bg-[#ed4e01] px-4 py-2 text-[13px] font-semibold not-italic text-white shadow-sm transition-colors hover:bg-[#d64601]"
      >
        {label}
        <IconArrowUpRight size={16} />
      </a>
    </div>
  );
}

function PromptVariants({
  variants,
  connectors,
  platformUrl,
  tryItLabel,
}: {
  variants: PromptVariant[];
  connectors: ConnectorRef[];
  platformUrl: string;
  tryItLabel: string;
}) {
  const [activeTab, setActiveTab] = useState(0);
  const activePrompt = variants[activeTab]?.prompt ?? "";

  return (
    <div>
      <div className="uc-prompt-tabs">
        {variants.map((v, i) => {
          return (
            <button
              key={v.label}
              className={`uc-prompt-tab ${i === activeTab ? "uc-prompt-tab--active" : ""}`}
              onClick={() => {
                return setActiveTab(i);
              }}
            >
              {v.label}
            </button>
          );
        })}
      </div>
      <div className="uc-prompt-block">
        {activePrompt}
        <TryItLink
          href={buildPromptHref(activePrompt, connectors, platformUrl)}
          label={tryItLabel}
        />
      </div>
    </div>
  );
}

export function UseCaseDetailClient({ useCase }: { useCase: UseCase }) {
  const t = useTranslations("useCases");
  const slug = useCase.slug;
  const platformUrl = getAppUrl();

  const promptVariants = t.raw(
    `content.${slug}.promptVariants`,
  ) as PromptVariant[];
  const steps = t.raw(`content.${slug}.steps`) as {
    title: string;
    description: string;
  }[];
  const nextActions = t.raw(`content.${slug}.nextActions`) as {
    title: string;
    description: string;
    examplePrompt: string;
  }[];
  const tips = t.raw(`content.${slug}.tips`) as string[];

  const title = t(`content.${slug}.title`);

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <article className="mx-auto max-w-[800px]">
          {/* Back link */}
          <Link href="/use-cases" className="uc-detail-back">
            &larr; {t("backToAll")}
          </Link>

          {/* Header */}
          <header style={{ marginBottom: 48 }}>
            <h1 className="text-[32px] font-semibold leading-[1.2] tracking-tight sm:text-[40px]">
              {title}
            </h1>
            <p className="mt-4 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {t(`content.${slug}.description`)}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-[14px] text-[hsl(var(--muted-foreground))]">
              <span className="font-medium text-[hsl(var(--foreground))]">
                {t("zeroConnects")}
              </span>
              {useCase.connectors.map((c) => {
                return <ConnectorBadge key={c.id} connector={c} />;
              })}
            </div>
          </header>

          {/* Section 1: What Zero delivers */}
          {(useCase.screenshots?.length ?? 0) > 0 && (
            <Section title={t("whatZeroDelivers")}>
              <ScreenshotCarousel
                screenshots={useCase.screenshots!}
                alt={`${title} — sample output from Zero`}
              />
            </Section>
          )}

          {/* Section 2: What the problem is */}
          <Section title={t("whatTheProblemIs")}>
            <p className="uc-section-body">{t(`content.${slug}.scenario`)}</p>
          </Section>

          {/* Section 3: How Zero fixes it */}
          <Section title={t("howZeroFixesIt")}>
            {/* Step 1: Connect your tools */}
            <div className="uc-subsection">
              <h3 className="uc-subsection-title">
                {t("stepConnectYourTools")}
              </h3>
              <div className="uc-connect-grid">
                {useCase.integrations.map((integration, i) => {
                  return (
                    <div key={i} className="uc-connect-card">
                      <div className="uc-connect-card-header">
                        {integration.connector.icon && (
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden">
                            <Image
                              src={integration.connector.icon}
                              alt={integration.connector.label}
                              width={32}
                              height={32}
                              className={`uc-integration-icon${integration.connector.dark ? " landing-icon-invert" : ""}${integration.connector.looseViewBox ? " scale-[2.2]" : ""}`}
                            />
                          </div>
                        )}
                        <div className="uc-connect-card-info">
                          <div className="uc-connect-card-name">
                            {integration.connector.label}
                          </div>
                          <span
                            className={`uc-integration-required ${
                              integration.required
                                ? "uc-integration-required--yes"
                                : "uc-integration-required--no"
                            }`}
                          >
                            {integration.required
                              ? t("required")
                              : t("optional")}
                          </span>
                        </div>
                      </div>
                      <div className="uc-connect-card-desc">
                        {t(`content.${slug}.integrations.${i}.description`)}
                      </div>
                      <a
                        href={
                          integration.connector.url
                            ? `${platformUrl}${integration.connector.url}`
                            : `${platformUrl}/connectors/${integration.connector.id}/connect`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="uc-connect-btn"
                      >
                        {t("connectLabel")}
                        <IconArrowUpRight size={14} />
                      </a>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Step 2: Ask Zero (prompts + what Zero does) */}
            <div className="uc-subsection">
              <h3 className="uc-subsection-title">{t("stepAskZero")}</h3>
              <PromptVariants
                variants={promptVariants}
                connectors={useCase.connectors}
                platformUrl={platformUrl}
                tryItLabel={t("tryIt")}
              />
              <div className="uc-steps" style={{ marginTop: 24 }}>
                {steps.map((step, i) => {
                  return (
                    <div key={i} className="uc-step">
                      <div className="uc-step-title">{step.title}</div>
                      <div className="uc-step-desc">{step.description}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Step 3: Take it further */}
            <div className="uc-subsection">
              <h3 className="uc-subsection-title">{t("stepTakeItFurther")}</h3>
              <div className="uc-next-actions">
                {nextActions.map((action, i) => {
                  return (
                    <div key={i} className="uc-next-action">
                      <div className="uc-next-action-title">{action.title}</div>
                      <div className="uc-next-action-desc">
                        {action.description}
                      </div>
                      <div className="uc-next-action-prompt group">
                        {action.examplePrompt}
                        <TryItLink
                          href={buildPromptHref(
                            action.examplePrompt,
                            useCase.connectors,
                            platformUrl,
                          )}
                          label={t("tryIt")}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Section>

          {/* Tips for better results */}
          <Section title={t("tipsForBetterResults")}>
            <div className="uc-tips">
              {tips.map((tip, i) => {
                return (
                  <div key={i} className="uc-tip">
                    <span className="uc-tip-icon">&#9679;</span>
                    <span>{tip}</span>
                  </div>
                );
              })}
            </div>
          </Section>
        </article>
      </main>

      <Footer />
    </div>
  );
}
