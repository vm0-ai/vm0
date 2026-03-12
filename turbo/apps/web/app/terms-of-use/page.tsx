"use client";

import { useEffect } from "react";

export default function TermsOfUsePage() {
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
        data-id="2d4a38d0-0baf-410c-a39d-86976b13052d"
      />
    </div>
  );
}
