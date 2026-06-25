"use client";

import { useEffect, type HTMLAttributes } from "react";

export function PrivacyPolicyClient() {
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
            data-id="e2483c7f-905a-4618-b026-94f823ff2332"
          />
        </div>
      </main>
    </div>
  );
}
