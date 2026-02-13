import Script from "next/script";

export default function TermsOfUsePage() {
  return (
    <div
      className="container"
      style={{ padding: "40px 20px", minHeight: "600px" }}
    >
      <Script
        id="termly-jssdk"
        src="https://app.termly.io/embed-policy.min.js"
        strategy="afterInteractive"
      />
      <div
        {...({ name: "termly-embed" } as React.HTMLAttributes<HTMLDivElement>)}
        data-id="2d4a38d0-0baf-410c-a39d-86976b13052d"
        data-type="iframe"
      />
    </div>
  );
}
