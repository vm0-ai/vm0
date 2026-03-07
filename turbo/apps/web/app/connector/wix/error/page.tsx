"use client";

import { useSearchParams } from "next/navigation";

/**
 * Wix Connector Error Page
 *
 * Displayed in the popup if linking the Wix connector fails.
 */
export default function WixConnectorErrorPage() {
  const searchParams = useSearchParams();
  const message =
    searchParams.get("message") ?? "An unexpected error occurred.";

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        textAlign: "center",
        background: "#fff",
        padding: "24px",
      }}
    >
      <div style={{ fontSize: "48px", color: "#ef4444", marginBottom: "16px" }}>
        ✗
      </div>
      <h2
        style={{
          fontSize: "20px",
          fontWeight: 600,
          margin: "0 0 8px",
          color: "#111",
        }}
      >
        Connection Failed
      </h2>
      <p
        style={{
          fontSize: "14px",
          color: "#555",
          maxWidth: "300px",
          lineHeight: 1.5,
        }}
      >
        {message}
      </p>
      <button
        style={{
          marginTop: "24px",
          background: "transparent",
          border: "1px solid #ddd",
          borderRadius: "8px",
          padding: "10px 20px",
          fontSize: "14px",
          cursor: "pointer",
        }}
        onClick={() => window.close()}
      >
        Close
      </button>
    </div>
  );
}
