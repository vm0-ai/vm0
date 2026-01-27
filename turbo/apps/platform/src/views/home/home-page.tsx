import { Card } from "@vm0/ui/components/ui/card";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import {
  IconBrandGithub,
  IconBrandDiscord,
  IconFileText,
  IconChevronRight,
} from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";
import { OnboardingModal } from "./onboarding-modal.tsx";

export function HomePage() {
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
            <UsefulReferences />
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
      <div className="w-1 h-6 bg-primary rounded-full" />
      <h2 className="text-base font-medium text-foreground">
        Step {step}: {title}
      </h2>
    </div>
  );
}

function Step1InstallSkill() {
  const command = "npx @vm0/cli setup-claude";

  return (
    <section>
      <StepHeader
        step={1}
        title="Install the VM0 builder skill and build with natural language"
      />
      <Card className="flex items-center justify-between p-4 font-mono">
        <code className="text-sm overflow-x-auto">
          <span className="text-primary">npx</span>{" "}
          <span className="text-primary">@vm0/cli</span>{" "}
          <span className="text-primary">setup-claude</span>{" "}
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
      <div className="flex items-start justify-between bg-muted/50 rounded-md p-3 font-mono">
        <code className="text-xs text-primary leading-relaxed whitespace-pre-wrap">
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
          icon={<span className="text-lg font-bold text-white">Y</span>}
          iconBg="bg-orange-500"
          commands={[
            "git clone https://github.com/vm0-ai/vm0-cookbooks",
            "cd vm0-cookbooks/201-hackernews",
            "vm0 cook start",
          ]}
        />
        <SampleAgentCard
          name="TikTok Influencer Finder"
          description="Search, filter, and surface TikTok creators for you"
          icon={
            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-pink-500 via-red-500 to-yellow-500" />
          }
          iconBg="bg-black"
          commands={[
            "git clone https://github.com/vm0-ai/vm0-cookbooks",
            "cd vm0-cookbooks/206-tiktok-influencer",
            "vm0 cook start",
          ]}
        />
      </div>
      <a
        href="https://github.com/vm0-ai/vm0-cookbooks/tree/main/examples"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 mt-4 text-sm text-primary hover:underline"
      >
        Show more sample agents
        <IconChevronRight className="h-4 w-4" />
      </a>
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
          href="https://discord.com/invite/WMpAmHFfp6"
        />
        <ReferenceCard
          title="Visit our GitHub"
          description="Explore our open-source code"
          icon={<IconBrandGithub className="h-5 w-5 text-white" />}
          iconBg="bg-gray-900"
          href="https://github.com/vm0-ai/vm0"
        />
        <ReferenceCard
          title="VM0 Professional Doc"
          description="Professional docs and guides"
          icon={<IconFileText className="h-5 w-5 text-primary" />}
          iconBg="bg-primary/10"
          href="https://docs.vm0.ai"
        />
      </div>
    </section>
  );
}
