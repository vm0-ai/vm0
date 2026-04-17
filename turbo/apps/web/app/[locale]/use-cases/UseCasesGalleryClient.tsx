"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { Link } from "../../../navigation";
import Footer from "../../components/Footer";
import Particles from "../../components/Particles";
import { USE_CASES } from "./data";
import type { UseCase, ConnectorRef, AvatarConfig } from "./data";

const AVATAR_BASE = "/assets/avatar";

function AgentAvatar({ config, size }: { config: AvatarConfig; size: number }) {
  const cls = "absolute inset-0 h-full w-full";
  return (
    <div
      className="relative overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={`${AVATAR_BASE}/head-r${config.rotation}-s${config.skin}.png`}
        className={cls}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={`${AVATAR_BASE}/hair-r${config.rotation}-h${config.hairStyle}-c${config.hairColor}.png`}
        className={cls}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={`${AVATAR_BASE}/face-r${config.rotation}-f${config.expression}-${config.intensity}.png`}
        className={cls}
      />
    </div>
  );
}

function ConnectorIcon({ connector }: { connector: ConnectorRef }) {
  if (!connector.icon) return null;
  return (
    <div
      className="flex items-center justify-center overflow-hidden rounded-[6px] bg-white p-1"
      style={{ width: 32, height: 32 }}
      title={connector.label}
    >
      <Image
        src={connector.icon}
        alt={connector.label}
        width={20}
        height={20}
        className={`object-contain${connector.dark ? " landing-icon-invert" : ""}${connector.looseViewBox ? " scale-[2.2]" : ""}`}
      />
    </div>
  );
}

function UseCaseCard({
  useCase,
  title,
  description,
}: {
  useCase: UseCase;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={`/use-cases/${useCase.slug}`}
      className="group block overflow-hidden rounded-[20px] bg-white transition-all duration-300 hover:-translate-y-0.5"
      style={{ textDecoration: "none" }}
    >
      {/* Colorful top area */}
      <div
        className="relative flex items-center justify-between px-6 pb-6 pt-16"
        style={{ backgroundColor: useCase.color }}
      >
        {/* Grid texture overlay */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        {/* Agent avatar */}
        <AgentAvatar config={useCase.avatar} size={64} />

        {/* Connector logos */}
        <div className="relative flex items-center gap-1.5" style={{ top: 10 }}>
          {useCase.connectors.map((c) => {
            return <ConnectorIcon key={c.id} connector={c} />;
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-3 px-6 pb-7 pt-5">
        <h3 className="text-lg font-medium leading-snug tracking-[-0.2px] text-[hsl(var(--foreground))] group-hover:text-[#ed4e01]">
          {title}
        </h3>
        <p className="line-clamp-3 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
          {description}
        </p>
      </div>
    </Link>
  );
}

export default function UseCasesGalleryClient() {
  const t = useTranslations("useCases");

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      {/* Hero */}
      <section className="hero-section" style={{ paddingBottom: "40px" }}>
        <div className="container">
          <h1 className="hero-title">{t("heroTitle")}</h1>
          <p className="hero-description">{t("heroSubtitle")}</p>
        </div>
      </section>

      {/* Card grid */}
      <section style={{ paddingBottom: "120px" }}>
        <div className="uc-grid">
          {USE_CASES.map((uc) => {
            return (
              <UseCaseCard
                key={uc.slug}
                useCase={uc}
                title={t(`content.${uc.slug}.title`)}
                description={t(`content.${uc.slug}.description`)}
              />
            );
          })}

          {/* Coming soon */}
          <div className="flex flex-col justify-between overflow-hidden rounded-[20px] bg-white px-6 pb-7 pt-5">
            <div className="flex flex-col gap-2">
              <h3 className="text-lg font-medium leading-snug tracking-[-0.2px] text-[hsl(var(--foreground))]">
                {t("gallery.moreToCome")}
              </h3>
              <p className="text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                {t("gallery.moreToComeDesc")}
              </p>
            </div>
            <a
              href="mailto:contact@vm0.ai"
              className="mt-4 inline-flex items-center gap-1 text-[14px] font-medium text-[#ed4e01] transition-all hover:gap-2"
            >
              {t("gallery.submitYourCase")}
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
