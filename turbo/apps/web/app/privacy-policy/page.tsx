import Script from "next/script";

export default function PrivacyPolicyPage() {
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
        data-id="e2483c7f-905a-4618-b026-94f823ff2332"
        data-type="iframe"
      />
    </div>
  );
}
