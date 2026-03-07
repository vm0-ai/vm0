"use client";

import { useEffect } from "react";

/**
 * Wix Connector Success Page
 *
 * Displayed in the popup after successfully linking the Wix connector.
 * Automatically closes the popup after a short delay.
 */
export default function WixConnectorSuccessPage() {
  useEffect(() => {
    const timer = setTimeout(() => {
      window.close();
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

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
      }}
    >
      <div style={{ fontSize: "48px", color: "#22c55e", marginBottom: "16px" }}>
        ✓
      </div>
      <h2
        style={{
          fontSize: "20px",
          fontWeight: 600,
          margin: "0 0 8px",
          color: "#111",
        }}
      >
        Connected!
      </h2>
      <p style={{ fontSize: "14px", color: "#555" }}>
        This window will close automatically.
      </p>
    </div>
  );
}
