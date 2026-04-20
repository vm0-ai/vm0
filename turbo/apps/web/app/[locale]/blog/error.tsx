"use client";

export default function BlogError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  console.error("[blog] Error boundary caught:", error);

  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: "480px" }}>
        <h2
          style={{
            fontSize: "24px",
            fontWeight: 600,
            color: "var(--text-primary, #ffffff)",
            marginBottom: "16px",
          }}
        >
          Blog temporarily unavailable
        </h2>
        <p
          style={{
            color: "var(--text-secondary, rgba(255, 255, 255, 0.8))",
            marginBottom: "24px",
            lineHeight: 1.6,
          }}
        >
          We&apos;re having trouble loading blog content. Please try again in a
          moment.
        </p>
        <button
          onClick={reset}
          style={{
            background: "var(--accent-color, #ed4e01)",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            padding: "12px 24px",
            fontSize: "16px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
