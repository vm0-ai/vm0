"use client";

import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

const SECTIONS = [
  {
    title: "Isolated execution",
    description:
      "Every agent run happens inside a completely isolated private environment. When the run finishes, the environment is destroyed automatically, nothing is left behind. Think of it like a disposable glove: clean, safe, and reliable.",
    detail:
      "Powered by Firecracker microVMs with hardware-level KVM isolation, not containers. Each run gets its own network namespace from a pre-allocated pool of 16,000+.",
  },
  {
    title: "Secrets never exposed",
    description:
      "Connecting Gmail, Slack, or GitHub? Your tokens and credentials are securely managed for you. The agent can use them, but it can never see or extract them. Even if something goes wrong in the agent's code, your accounts stay safe.",
    detail:
      "Credentials are injected at the network layer via transparent MITM proxy. Agent code never touches raw tokens. Outbound requests are scanned to prevent secret leakage.",
  },
  {
    title: "Starts in seconds",
    description:
      "We've done extensive optimization under the hood so your agent goes from trigger to running in tens of milliseconds. Fast, because we put in the hard work at the infrastructure level. You just experience the result.",
    detail:
      "Overlayfs with shared read-only rootfs for zero-copy boot. VM memory snapshots pre-warm the entire runtime stack, restore instead of cold start.",
  },
  {
    title: "Full audit trail",
    description:
      "Every action the agent takes, which services it accessed, which APIs it called, what it produced, is logged. If something goes wrong, there's a clear record. If nothing goes wrong, you still have peace of mind.",
    detail:
      "Complete HTTP/HTTPS traffic logged per run (JSONL). Immutable, content-addressed artifacts stored on Cloudflare R2 with SHA-256 integrity.",
  },
  {
    title: "Open source",
    description:
      "The core platform is open source. You can inspect the code, audit the security model, and contribute. Transparent by default.",
    detail:
      "Core platform on GitHub. Regular third-party penetration testing. SOC 2 Type II compliance in progress.",
  },
];

export default function SecurityPage() {
  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <div className="header-container">
        <Navbar />
      </div>

      <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-[32px] font-semibold leading-[1.2] tracking-tight sm:text-[40px]">
            Security
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
            When you hand work to an AI agent, your biggest concerns are data
            safety, privacy, and staying in control. VM0 was designed from day
            one with all of this in mind.
          </p>

          <div className="mt-12 space-y-10">
            {SECTIONS.map(({ title, description, detail }) => {
              return (
                <div key={title}>
                  <h2 className="text-[15px] font-semibold text-[hsl(var(--foreground))]">
                    {title}
                  </h2>
                  <p className="mt-2 text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                    {description}
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-[hsl(var(--muted-foreground))]/50">
                    {detail}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="mt-16 border-t border-[hsl(var(--gray-200))] pt-8">
            <p className="text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
              Questions about security?{" "}
              <a
                href="mailto:contact@vm0.ai"
                className="text-[hsl(var(--foreground))] underline underline-offset-4"
              >
                Contact us
              </a>
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
