"use client";

import { useEffect } from "react";

export default function PrivacyPolicyPage() {
  useEffect(() => {
    if (document.getElementById("termly-jssdk")) return;
    const script = document.createElement("script");
    script.id = "termly-jssdk";
    script.src = "https://app.termly.io/embed-policy.min.js";
    document.body.appendChild(script);
  }, []);

  return (
    <div
      className="container"
      style={{ padding: "40px 20px", minHeight: "600px" }}
    >
      <div
        {...({ name: "termly-embed" } as React.HTMLAttributes<HTMLDivElement>)}
        data-id="e2483c7f-905a-4618-b026-94f823ff2332"
      />
    </div>
  );
}
