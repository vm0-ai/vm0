"use client";

import type { ReactNode } from "react";
import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";
import Image from "next/image";

type DesktopAuthStatusTone = "loading" | "waiting" | "success" | "error";

interface DesktopAuthStatusPageProps {
  readonly children?: ReactNode;
  readonly description: string;
  readonly title: string;
  readonly tone?: DesktopAuthStatusTone;
}

function StatusIcon({
  tone,
}: {
  readonly tone: DesktopAuthStatusTone;
}): React.JSX.Element | null {
  if (tone === "loading") {
    return (
      <IconLoader2
        size={34}
        className="animate-spin text-muted-foreground"
        stroke={1.5}
      />
    );
  }

  if (tone === "success") {
    return <IconCheck size={40} className="text-lime-600" stroke={1} />;
  }

  if (tone === "error") {
    return (
      <IconAlertCircle size={38} className="text-destructive" stroke={1.25} />
    );
  }

  return null;
}

export function DesktopAuthStatusPage({
  children,
  description,
  title,
  tone = "loading",
}: DesktopAuthStatusPageProps): React.JSX.Element {
  const showIcon = tone !== "waiting";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center p-10">
          <div className="mb-8 flex items-center gap-2">
            <Image
              src="/assets/vm0-logo-dark.svg"
              alt="VM0"
              width={82}
              height={20}
              priority
              className="dark:hidden"
            />
            <Image
              src="/assets/vm0-logo.svg"
              alt="VM0"
              width={82}
              height={20}
              priority
              className="hidden dark:block"
            />
            <span className="text-2xl text-foreground">Platform</span>
          </div>
          {showIcon ? (
            <div className="mb-4 flex items-center">
              <StatusIcon tone={tone} />
            </div>
          ) : null}
          <div className="mt-4 flex flex-col items-center gap-2 text-center">
            <h1 className="text-lg font-medium leading-7 text-foreground">
              {title}
            </h1>
            <p className="text-sm leading-5 text-muted-foreground">
              {description}
            </p>
          </div>
          {children ? <div className="mt-6 w-full">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}
