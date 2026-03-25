import { useLoadable } from "ccstate-react";
import { Button } from "@vm0/ui";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";

interface ZeroAboutPageProps {
  onBack?: () => void;
}

export function ZeroAboutPage({ onBack }: ZeroAboutPageProps) {
  const displayNameLoadable = useLoadable(agentDisplayName$);
  const displayName =
    displayNameLoadable.state === "hasData" ? displayNameLoadable.data : "Zero";
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto">
      <div className="mx-auto max-w-[900px] w-full px-4 sm:px-6 py-10 sm:py-14">
        <div className="flex flex-col gap-10">
          <div>
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 mb-6 text-muted-foreground hover:text-foreground"
                onClick={onBack}
              >
                ← Back
              </Button>
            )}
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
              About VM0 Zero
            </h1>
            <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-[560px]">
              {displayName} is your AI teammate, not just a tool. It automates
              workflows, grows with you, and works where you already are: in
              Slack, on the web, with access to what you need and memory of what
              you’ve done. Safe, easy to use, and built to feel like part of the
              team.
            </p>
          </div>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Who {displayName} is for
            </h2>
            <p className="text-sm text-foreground leading-relaxed">
              Whether you’re technical or not, {displayName} is ready. Use it
              for quick help or go deep with workflows and automation. Everyone
              can get started; power users can do more.
            </p>
            <ul className="space-y-3 text-sm text-foreground leading-relaxed">
              <li className="flex gap-3">
                <span className="text-primary shrink-0">·</span>
                <span>
                  <strong className="text-foreground">Managers</strong>. Use
                  {displayName} in Slack and your workspace to boost team
                  efficiency, coordinate work, and treat it like an AI teammate
                  that supports the whole team.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary shrink-0">·</span>
                <span>
                  <strong className="text-foreground">Employees</strong>. Get
                  more done day to day: organize information, run tasks, and
                  improve how you work with others.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary shrink-0">·</span>
                <span>
                  <strong className="text-foreground">Individuals</strong>. Your
                  personal assistant on the web or in Slack: look things up, run
                  tasks, and keep track of what {displayName} is handling for
                  you.
                </span>
              </li>
            </ul>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              How {displayName} works
            </h2>
            <ul className="space-y-3 text-sm text-foreground leading-relaxed">
              <li className="flex gap-3">
                <span className="text-primary shrink-0">·</span>
                <span>
                  <strong className="text-foreground">
                    IM + where you work
                  </strong>
                  . Chat in Slack or on the web; {displayName} fits into your
                  existing channels.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary shrink-0">·</span>
                <span>
                  <strong className="text-foreground">
                    Local access & memory
                  </strong>
                  . Connects to the resources you allow and remembers context so
                  it gets better over time.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-primary shrink-0">·</span>
                <span>
                  <strong className="text-foreground">
                    Automation that grows
                  </strong>
                  . Run workflows, schedule agents, and let {displayName} take
                  on more as you do.
                </span>
              </li>
            </ul>
          </section>

          <section className="pt-4 border-t border-border">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {displayName} is built by VM0. Secure, friendly, and designed to
              feel like a teammate.
            </p>
            <a
              href="https://vm0.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-3 text-sm font-medium text-primary hover:underline"
            >
              Learn more at vm0.ai →
            </a>
          </section>
        </div>
      </div>
    </div>
  );
}
