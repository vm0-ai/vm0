"use client";

import { useTranslations } from "next-intl";
import Footer from "../../components/Footer";

const SECTION_KEYS = [
  "isolatedExecution",
  "secretsNeverExposed",
  "startsInSeconds",
  "fullAuditTrail",
  "openSource",
] as const;

export default function SecurityPage() {
  const t = useTranslations("securityPage");

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-[32px] font-semibold leading-[1.2] tracking-tight sm:text-[40px]">
            {t("title")}
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
            {t("intro")}
          </p>

          <div className="mt-12 space-y-10">
            {SECTION_KEYS.map((key) => {
              return (
                <div key={key}>
                  <h2 className="text-[15px] font-semibold text-[hsl(var(--foreground))]">
                    {t(`${key}.title`)}
                  </h2>
                  <p className="mt-2 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                    {t(`${key}.description`)}
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-[hsl(var(--muted-foreground))]/50">
                    {t(`${key}.detail`)}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="mt-16 border-t border-[hsl(var(--gray-200))] pt-8">
            <p className="text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
              {t("questionsAboutSecurity")}{" "}
              <a
                href="mailto:contact@vm0.ai"
                className="text-[hsl(var(--foreground))] underline underline-offset-4"
              >
                {t("contactUs")}
              </a>
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
