"use client";

import { useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Link } from "../../../../navigation";
import Navbar from "../../../components/Navbar";
import Footer from "../../../components/Footer";
import Particles from "../../../components/Particles";
import type { UseCase, ConnectorRef } from "../data";

function ConnectorBadge({ connector }: { connector: ConnectorRef }) {
  if (!connector.icon) return null;
  return (
    <span className="uc-connector-badge" title={connector.label}>
      <Image
        src={connector.icon}
        alt={connector.label}
        width={20}
        height={20}
        className="uc-connector-icon"
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

function PromptVariants({ variants }: { variants: UseCase["promptVariants"] }) {
  const [activeTab, setActiveTab] = useState(0);

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
      <div className="uc-prompt-block">{variants[activeTab]?.prompt}</div>
    </div>
  );
}

export default function UseCaseDetailClient({ useCase }: { useCase: UseCase }) {
  const t = useTranslations("useCases");

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />
      <div className="header-container">
        <Navbar />
      </div>

      <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <article className="mx-auto max-w-[800px]">
          {/* Back link */}
          <Link href="/use-cases" className="uc-detail-back">
            &larr; {t("backToAll")}
          </Link>

          {/* Header */}
          <header style={{ marginBottom: 48 }}>
            <h1 className="text-[32px] font-semibold leading-[1.2] tracking-tight sm:text-[40px]">
              {useCase.title}
            </h1>
            <p className="mt-4 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {useCase.description}
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
                title={useCase.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="aspect-video w-full rounded-[12px]"
                style={{ border: "none" }}
              />
            </div>
          )}

          {/* Scenario */}
          <Section title={useCase.headings.scenario}>
            <p className="uc-section-body">{useCase.scenario}</p>
          </Section>

          {/* Prompt */}
          <Section title={useCase.headings.prompt}>
            <PromptVariants variants={useCase.promptVariants} />
          </Section>

          {/* Steps */}
          <Section title={useCase.headings.steps}>
            <div className="uc-steps">
              {useCase.steps.map((step, i) => {
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
          <Section title={useCase.headings.nextActions}>
            <div className="uc-next-actions">
              {useCase.nextActions.map((action, i) => {
                return (
                  <div key={i} className="uc-next-action">
                    <div className="uc-next-action-title">{action.title}</div>
                    <div className="uc-next-action-desc">
                      {action.description}
                    </div>
                    <div className="uc-next-action-prompt">
                      {action.examplePrompt}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Integrations */}
          <Section title={useCase.headings.integrations}>
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
                        className="uc-integration-icon"
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
                        {integration.description}
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
              {useCase.headings.tips}
            </h2>
            <div className="uc-tips">
              {useCase.tips.map((tip, i) => {
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
