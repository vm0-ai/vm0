"use client";

import { useState } from "react";
import Image from "next/image";
import { IconArrowUpRight } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { Link } from "../../../../navigation";
import Footer from "../../../components/Footer";
import Particles from "../../../components/Particles";
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
    <span className="uc-connector-badge" title={connector.label}>
      <Image
        src={connector.icon}
        alt={connector.label}
        width={20}
        height={20}
        className={`uc-connector-icon${connector.dark ? " landing-icon-invert" : ""}`}
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

function TryItLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-2 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 text-[13px] font-medium text-[#ed4e01]"
      >
        {label}
        <IconArrowUpRight size={14} />
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
      <div className="uc-prompt-block group">
        {activePrompt}
        <TryItLink
          href={buildPromptHref(activePrompt, connectors, platformUrl)}
          label={tryItLabel}
        />
      </div>
    </div>
  );
}

export default function UseCaseDetailClient({ useCase }: { useCase: UseCase }) {
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

          {/* Video preview */}
          {useCase.videoId && (
            <div className="uc-video-embed" style={{ marginBottom: 48 }}>
              <iframe
                src={`https://www.youtube.com/embed/${useCase.videoId}`}
                title={title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="aspect-video w-full rounded-[12px]"
                style={{ border: "none" }}
              />
            </div>
          )}

          {/* Scenario */}
          <Section title={t(`content.${slug}.headings.scenario`)}>
            <p className="uc-section-body">{t(`content.${slug}.scenario`)}</p>
          </Section>

          {/* Prompt */}
          <Section title={t(`content.${slug}.headings.prompt`)}>
            <PromptVariants
              variants={promptVariants}
              connectors={useCase.connectors}
              platformUrl={platformUrl}
              tryItLabel={t("tryIt")}
            />
          </Section>

          {/* Steps */}
          <Section title={t(`content.${slug}.headings.steps`)}>
            <div className="uc-steps">
              {steps.map((step, i) => {
                return (
                  <div key={i} className="uc-step">
                    <div className="uc-step-title">{step.title}</div>
                    <div className="uc-step-desc">{step.description}</div>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Next actions */}
          <Section title={t(`content.${slug}.headings.nextActions`)}>
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
          </Section>

          {/* Integrations */}
          <Section title={t(`content.${slug}.headings.integrations`)}>
            <div className="uc-integrations">
              {useCase.integrations.map((integration, i) => {
                return (
                  <div key={i} className="uc-integration">
                    {integration.connector.icon ? (
                      <Image
                        src={integration.connector.icon}
                        alt={integration.connector.label}
                        width={32}
                        height={32}
                        className={`uc-integration-icon${integration.connector.dark ? " landing-icon-invert" : ""}`}
                      />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--gray-100))] text-sm font-medium text-[hsl(var(--muted-foreground))]">
                        {integration.connector.label[0]}
                      </div>
                    )}
                    <div className="uc-integration-info">
                      <div className="uc-integration-name">
                        {integration.connector.label}
                      </div>
                      <div className="uc-integration-desc">
                        {t(`content.${slug}.integrations.${i}.description`)}
                      </div>
                    </div>
                    <span
                      className={`uc-integration-required ${
                        integration.required
                          ? "uc-integration-required--yes"
                          : "uc-integration-required--no"
                      }`}
                    >
                      {integration.required ? t("required") : t("optional")}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Tips */}
          <div className="uc-section">
            <h2 className="uc-section-title" style={{ marginBottom: 16 }}>
              {t(`content.${slug}.headings.tips`)}
            </h2>
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
          </div>
        </article>
      </main>

      <Footer />
    </div>
  );
}
