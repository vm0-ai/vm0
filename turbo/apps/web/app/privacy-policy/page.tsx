"use client";

import { useEffect } from "react";

export default function PrivacyPolicyPage() {
  useEffect(() => {
    // Load Termly script
    const script = document.createElement("script");
    script.id = "termly-jssdk";
    script.src = "https://app.termly.io/embed-policy.min.js";
    script.async = true;

    script.onload = () => {
      console.log("Termly script loaded successfully");
    };

    script.onerror = () => {
      console.error("Failed to load Termly script");
    };

    if (!document.getElementById("termly-jssdk")) {
      document.body.appendChild(script);
    }

    return () => {
      const existingScript = document.getElementById("termly-jssdk");
      if (existingScript) {
        existingScript.remove();
      }
    };
  }, []);

  return (
    <div
      className="container"
      style={{ padding: "40px 20px", minHeight: "600px" }}
    >
      <div
        {...({ name: "termly-embed" } as React.HTMLAttributes<HTMLDivElement>)}
        data-id="e2483c7f-905a-4618-b026-94f823ff2332"
        data-type="iframe"
      />
    </div>
  );
}
