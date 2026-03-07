"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Wix Dashboard Extension iFrame Page
 *
 * Loaded by Wix as an iFrame inside the user's Wix Dashboard after
 * installing the VM0 app. Opens a popup to /api/connectors/wix/link
 * to complete the connection with proper VM0 authentication.
 */
export default function WixConnectorPage() {
  const searchParams = useSearchParams();
  const instance = searchParams.get("instance");
  const [status, setStatus] = useState<
    "idle" | "connecting" | "done" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    if (!instance) return;

    const checkPopup = setInterval(() => {
      if (popupRef.current?.closed) {
        clearInterval(checkPopup);
        // Popup closed — check if connection succeeded by pinging our API
        fetch("/api/connectors/wix/status", { credentials: "include" })
          .then((r) => r.json())
          .then((data: { connected: boolean }) => {
            if (data.connected) {
              setStatus("done");
            } else {
              setStatus("error");
              setErrorMessage(
                "Connection was not completed. Please try again.",
              );
            }
          })
          .catch(() => {
            setStatus("error");
            setErrorMessage("Could not verify connection status.");
          });
      }
    }, 500);

    return () => clearInterval(checkPopup);
  }, [instance]);

  function handleConnect() {
    if (!instance) return;

    const linkUrl = `/api/connectors/wix/link?instance=${encodeURIComponent(instance)}`;
    const popup = window.open(
      linkUrl,
      "wix-connect",
      "width=500,height=700,menubar=no,toolbar=no,location=no",
    );
    popupRef.current = popup;
    setStatus("connecting");
  }

  if (!instance) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>
          Missing instance parameter. Please reinstall the app.
        </p>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div style={styles.container}>
        <div style={styles.success}>✓</div>
        <h2 style={styles.heading}>Connected!</h2>
        <p style={styles.text}>Your Wix site is now connected to VM0.</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={styles.container}>
        <h2 style={styles.heading}>Connection Failed</h2>
        <p style={styles.error}>{errorMessage}</p>
        <button style={styles.button} onClick={handleConnect}>
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Connect to VM0</h2>
      <p style={styles.text}>
        Link your Wix site to VM0 to enable AI-powered content creation.
      </p>
      <button
        style={status === "connecting" ? styles.buttonDisabled : styles.button}
        onClick={handleConnect}
        disabled={status === "connecting"}
      >
        {status === "connecting" ? "Connecting…" : "Connect VM0 Account"}
      </button>
      {status === "connecting" && (
        <p style={styles.hint}>Complete the sign-in in the popup window.</p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: "24px",
    textAlign: "center",
    background: "#fff",
  },
  heading: {
    fontSize: "20px",
    fontWeight: 600,
    margin: "0 0 12px",
    color: "#111",
  },
  text: {
    fontSize: "14px",
    color: "#555",
    margin: "0 0 24px",
    maxWidth: "300px",
    lineHeight: 1.5,
  },
  hint: {
    fontSize: "12px",
    color: "#999",
    marginTop: "12px",
  },
  button: {
    background: "#1a1a1a",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    padding: "12px 24px",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
  },
  buttonDisabled: {
    background: "#999",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    padding: "12px 24px",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "not-allowed",
  },
  success: {
    fontSize: "48px",
    color: "#22c55e",
    marginBottom: "16px",
  },
  error: {
    fontSize: "14px",
    color: "#ef4444",
    margin: "0 0 16px",
  },
};
