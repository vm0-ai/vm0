"use client";

import Image from "next/image";
import { IconSparkles } from "@tabler/icons-react";
import { useMemo } from "react";
import { getAppUrl } from "../../../src/lib/zero/url";

function parseHostedWebsite(value: string | null): string | null {
  if (!value || !URL.canParse(value)) {
    return null;
  }

  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.toString()
    : null;
}

export function ShowcaseClient({
  prompt,
  websiteUrl,
}: {
  prompt: string;
  websiteUrl: string | null;
}) {
  const website = parseHostedWebsite(websiteUrl);
  const onboardingHref = useMemo(() => {
    const url = new URL("/onboarding", getAppUrl());
    if (prompt) {
      url.searchParams.set("prompt", prompt);
    }
    return url.toString();
  }, [prompt]);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col bg-white">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-black/10 bg-white px-4">
        <Image
          src="/assets/vm0-logo-dark.svg"
          alt="VM0"
          width={80}
          height={24}
          priority
        />
        <a
          href={onboardingHref}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] bg-[#ed4e01] px-3.5 text-sm font-medium text-white transition-colors hover:bg-[#d94600]"
        >
          <IconSparkles size={15} stroke={2} />
          Create with this style
        </a>
      </header>

      {website ? (
        <iframe
          src={website}
          title="Website design showcase"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
        />
      ) : (
        <section className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-md text-center">
            <h1 className="text-lg font-medium text-[hsl(var(--foreground))]">
              Website preview unavailable
            </h1>
            <p className="mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
              This showcase link is missing a valid website URL. Return to the
              website design gallery and open one of the examples.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
