import { Button } from "@vm0/ui/components/ui/button";
import { Card } from "@vm0/ui/components/ui/card";
import {
  IconSparkles,
  IconBrandGithub,
  IconBrandDiscord,
  IconBolt,
  IconCopy,
} from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";
import { OnboardingModal } from "./onboarding-modal.tsx";
import { useLastResolved } from "ccstate-react";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

export function HomePage() {
  const features = useLastResolved(featureSwitch$);

  return (
    <>
      <AppShell
        breadcrumb={["Get started"]}
        title="Welcome. You're in."
        subtitle="A few things you can explore with VM0"
        gradientBackground
      >
        <div className="flex flex-col gap-10 px-8 pb-8">
          {features?.platformOnboarding && (
            <>
              <Step1LLMProvider />
              <Step2SampleAgents />
              <Step3InstallSkills />
              <UsefulReferences />
            </>
          )}
        </div>
      </AppShell>
      <OnboardingModal />
    </>
  );
}

function StepHeader({ step, title }: { step: number; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <div className="w-1 h-6 bg-primary rounded-full" />
      <h2 className="text-base font-medium text-foreground">
        Step {step}: {title}
      </h2>
    </div>
  );
}

function Step1LLMProvider() {
  return (
    <section>
      <StepHeader step={1} title="Provider your LLM provider" />
      <Card className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100">
            <IconSparkles className="h-5 w-5 text-primary-800" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              Your LLM provider
            </p>
            <p className="text-xs text-muted-foreground">
              Enter LLM provider secrets
            </p>
          </div>
        </div>
        <Button size="sm">Fill</Button>
      </Card>
    </section>
  );
}

function AgentCard({
  name,
  description,
  icon,
  iconBg,
}: {
  name: string;
  description: string;
  icon: React.ReactNode;
  iconBg: string;
}) {
  return (
    <Card className="flex items-center justify-between p-4">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg shrink-0 ${iconBg}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {description}
          </p>
        </div>
      </div>
      <Button size="sm" className="ml-3 shrink-0">
        Run
      </Button>
    </Card>
  );
}

function Step2SampleAgents() {
  return (
    <section>
      <StepHeader step={2} title="Run a sample agent" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <AgentCard
          name="Hacker News Research"
          description="Get the latest insights from Hacker News"
          icon={<span className="text-lg font-bold text-white">Y</span>}
          iconBg="bg-orange-500"
        />
        <AgentCard
          name="TikTok Influencer Finder"
          description="Search, filter, and surface TikTok creators for you"
          icon={<span className="text-lg font-bold text-white">♪</span>}
          iconBg="bg-black"
        />
        <AgentCard
          name="TikTok Influencer Finder"
          description="Search, filter, and surface TikTok creators for you"
          icon={<span className="text-lg font-bold text-white">♪</span>}
          iconBg="bg-black"
        />
      </div>
    </section>
  );
}

function Step3InstallSkills() {
  const command = "npm install -g @vm0/cli";

  const handleCopy = () => {
    navigator.clipboard.writeText(command).catch(() => {
      // Clipboard API not available
    });
  };

  return (
    <section>
      <StepHeader step={3} title="Install VM0 Skills in Claude Code" />
      <Card className="flex items-center justify-between p-4 font-mono">
        <code className="text-sm">
          <span className="text-primary-800">npm</span>{" "}
          <span className="text-foreground">install -g</span>{" "}
          <span className="text-primary-800">@vm0/cli</span>{" "}
          <span className="text-muted-foreground">
            {"// Install VM0 skill"}
          </span>
        </code>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCopy}
          className="shrink-0"
        >
          <IconCopy className="h-4 w-4" />
        </Button>
      </Card>
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
    <a href={href} target="_blank" rel="noopener noreferrer">
      <Card className="flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors cursor-pointer">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconBg}`}
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

function UsefulReferences() {
  return (
    <section>
      <h2 className="text-base font-medium text-foreground mb-4">
        Useful reference
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ReferenceCard
          title="Explore our community"
          description="Join us on Discord"
          icon={<IconBrandDiscord className="h-5 w-5 text-white" />}
          iconBg="bg-indigo-500"
          href="https://discord.gg/vm0"
        />
        <ReferenceCard
          title="Visit our GitHub"
          description="Explore our open-source code"
          icon={<IconBrandGithub className="h-5 w-5 text-white" />}
          iconBg="bg-gray-900"
          href="https://github.com/anthropics/claude-code"
        />
        <ReferenceCard
          title="VM0 agent skills"
          description="71+ of agent skills by VM0"
          icon={<IconBolt className="h-5 w-5 text-primary-800" />}
          iconBg="bg-primary-100"
          href="/skills"
        />
      </div>
    </section>
  );
}
