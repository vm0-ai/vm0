import { Card } from "@vm0/ui/components/ui/card";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { Button } from "@vm0/ui/components/ui/button";
import { IconBook, IconChevronRight } from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";
import { OnboardingModal } from "./onboarding-modal.tsx";
import { useGet } from "ccstate-react";
import { theme$ } from "../../signals/theme.ts";

export function HomePage() {
  const theme = useGet(theme$);
  return (
    <>
      <AppShell
        breadcrumb={["Get started"]}
        title="Welcome. Let's build your agent fast."
        subtitle="Follow the steps below and let it run."
        gradientBackground
      >
        <div className="flex flex-col gap-10 px-8 pb-8">
          <>
            <Step1InstallSkill />
            <Step2SampleAgents />
            <UsefulReferences theme={theme} />
          </>
        </div>
      </AppShell>
      <OnboardingModal />
    </>
  );
}

function StepHeader({ step, title }: { step: number; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <div className="w-0.5 h-5 bg-primary" />
      <h2 className="text-base font-medium text-foreground">
        Step {step}: {title}
      </h2>
    </div>
  );
}

function Step1InstallSkill() {
  const command = "npm install -g @vm0/cli && vm0 onboard";

  return (
    <section>
      <StepHeader
        step={1}
        title="Install the VM0 CLI and build AI agents with natural language"
      />
      <Card className="flex items-center justify-between p-4 font-mono">
        <code className="text-sm overflow-x-auto text-muted-foreground">
          <span>npm install -g @vm0/cli && vm0 onboard</span>
        </code>
        <CopyButton text={`${command}`} />
      </Card>
    </section>
  );
}

function SampleAgentCard({
  name,
  description,
  icon,
  iconBg,
  commands,
}: {
  name: string;
  description: string;
  icon: React.ReactNode;
  iconBg: string;
  commands: string[];
}) {
  const commandText = commands.join("\n");

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center gap-3 mb-4">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg shrink-0 ${iconBg}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{name}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex items-start justify-between bg-sidebar rounded-md p-3 font-mono">
        <code className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
          {commands.map((cmd) => (
            <div key={cmd}>{cmd}</div>
          ))}
        </code>
        <CopyButton text={commandText} />
      </div>
    </Card>
  );
}

function Step2SampleAgents() {
  return (
    <section>
      <StepHeader step={2} title="Try a sample agent" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SampleAgentCard
          name="Hacker News Research"
          description="Get the latest insights from Hacker News"
          icon={
            <img
              src="/hackernews-platform.svg"
              alt="Hacker News"
              className="h-10 w-10"
            />
          }
          iconBg=""
          commands={[
            "git clone https://github.com/vm0-ai/vm0-cookbooks",
            "cd vm0-cookbooks/examples/201-hackernews",
            "vm0 setup-claude",
            'claude "Show me the agent and run it."',
          ]}
        />
        <SampleAgentCard
          name="TikTok Influencer Finder"
          description="Search, filter, and surface TikTok creators for you"
          icon={
            <img
              src="/tiktok-platform.svg"
              alt="TikTok"
              className="h-10 w-10"
            />
          }
          iconBg=""
          commands={[
            "git clone https://github.com/vm0-ai/vm0-cookbooks",
            "cd vm0-cookbooks/examples/206-tiktok-influencer",
            "vm0 setup-claude",
            'claude "Show me the agent and run it."',
          ]}
        />
      </div>
      <Button variant="ghost" size="sm" className="mt-1" asChild>
        <a
          href="https://github.com/vm0-ai/vm0-cookbooks/tree/main/examples"
          target="_blank"
          rel="noreferrer"
        >
          Show more sample agents
          <IconChevronRight className="h-4 w-4" />
        </a>
      </Button>
    </section>
  );
}

function ReferenceCard({
  title,
  description,
  icon,
  iconBg,
  href,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  iconBg: string;
  href: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="h-full">
      <Card className="h-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors cursor-pointer">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${iconBg}`}
        >
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </Card>
    </a>
  );
}

function UsefulReferences({ theme }: { theme: string }) {
  return (
    <section>
      <h2 className="text-base font-medium text-foreground mb-4">
        Useful reference
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <ReferenceCard
          title="Explore our community"
          description="Join us on Discord"
          icon={
            <img
              src="/discord-platform.svg"
              alt="Discord"
              className="h-8 w-8"
            />
          }
          iconBg=""
          href="https://discord.com/invite/WMpAmHFfp6"
        />
        <ReferenceCard
          title="Visit our GitHub"
          description="Explore our open-source code"
          icon={
            <img
              src={
                theme === "dark"
                  ? "/github-platform-dark.svg"
                  : "/github-platform.svg"
              }
              alt="GitHub"
              className="h-8 w-8"
            />
          }
          iconBg=""
          href="https://github.com/vm0-ai/vm0"
        />
        <ReferenceCard
          title="Docs for developers"
          description="Complete guides and CLI reference"
          icon={<IconBook className="h-8 w-8 text-primary" stroke={1.5} />}
          iconBg=""
          href="https://docs.vm0.ai"
        />
        <ReferenceCard
          title="Vibe coding quick start"
          description="Build agents with Claude Code"
          icon={<IconBook className="h-8 w-8 text-primary" stroke={1.5} />}
          iconBg=""
          href="https://docs.vm0.ai/docs/vibe-coder-quickstart"
        />
      </div>
    </section>
  );
}
