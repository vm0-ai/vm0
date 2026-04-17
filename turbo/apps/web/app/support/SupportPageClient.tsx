"use client";

import Footer from "../components/Footer";

export default function SupportPageClient() {
  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-[32px] font-semibold leading-[1.2] tracking-tight sm:text-[40px]">
            Support
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
            Need help with VM0? Reach out through any of the channels below. We
            typically reply to email within one business day.
          </p>

          <div className="mt-12 space-y-10">
            <div>
              <h2 className="text-[15px] font-semibold text-[hsl(var(--foreground))]">
                Email support
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                For account questions, billing issues, or anything that is not
                working as expected, email{" "}
                <a
                  href="mailto:support@vm0.ai"
                  className="text-[hsl(var(--foreground))] underline underline-offset-4"
                >
                  support@vm0.ai
                </a>
                . We aim to respond within one business day (Monday–Friday).
              </p>
            </div>

            <div>
              <h2 className="text-[15px] font-semibold text-[hsl(var(--foreground))]">
                Community chat
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                Join other VM0 users and the team on{" "}
                <a
                  href="https://discord.gg/WMpAmHFfp6"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[hsl(var(--foreground))] underline underline-offset-4"
                >
                  Discord
                </a>{" "}
                for quick questions, tips, and feature discussions.
              </p>
            </div>

            <div>
              <h2 className="text-[15px] font-semibold text-[hsl(var(--foreground))]">
                Bug reports & feature requests
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                File issues on{" "}
                <a
                  href="https://github.com/vm0-ai/vm0/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[hsl(var(--foreground))] underline underline-offset-4"
                >
                  GitHub
                </a>
                . VM0 is open-source, so you can also follow development and
                contribute directly.
              </p>
            </div>

            <div>
              <h2 className="text-[15px] font-semibold text-[hsl(var(--foreground))]">
                Service status
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                Check real-time uptime and incident history at{" "}
                <a
                  href="https://status.vm0.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[hsl(var(--foreground))] underline underline-offset-4"
                >
                  status.vm0.ai
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
