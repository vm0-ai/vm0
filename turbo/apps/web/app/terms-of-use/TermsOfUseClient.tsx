"use client";

import { useEffect, type HTMLAttributes } from "react";

export function TermsOfUseClient() {
  useEffect(() => {
    if (document.getElementById("termly-jssdk")) return;
    const script = document.createElement("script");
    script.id = "termly-jssdk";
    script.src = "https://app.termly.io/embed-policy.min.js";
    document.body.appendChild(script);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="px-6 py-16 md:py-24">
        <div className="termly-embed-wrapper mx-auto max-w-2xl">
          <div
            {...({
              name: "termly-embed",
            } as HTMLAttributes<HTMLDivElement>)}
            data-id="2d4a38d0-0baf-410c-a39d-86976b13052d"
          />
        </div>
      </main>
    </div>
  );
}
