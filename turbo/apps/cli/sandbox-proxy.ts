#!/usr/bin/env tsx
/**
 * Sandbox Local Proxy
 *
 * Maps external computer connector services to localhost ports inside sandbox:
 * - localhost:9222 (WebSocket) → wss://chrome.{domain} (Chrome CDP)
 * - localhost:18080 (HTTP) → https://webdav.{domain} (WebDAV)
 */
import WebSocket from "ws";
import http from "http";
import https from "https";

const BRIDGE_TOKEN = process.env.COMPUTER_CONNECTOR_BRIDGE_TOKEN;
const DOMAIN = process.env.COMPUTER_CONNECTOR_DOMAIN;

if (!BRIDGE_TOKEN || !DOMAIN) {
  console.error("Missing required environment variables:");
  console.error("  COMPUTER_CONNECTOR_BRIDGE_TOKEN");
  console.error("  COMPUTER_CONNECTOR_DOMAIN");
  process.exit(1);
}

// Chrome CDP WebSocket Proxy (localhost:9222 → wss://chrome.{domain})
const wss = new WebSocket.Server({ host: "127.0.0.1", port: 9222 });
console.log("✅ Chrome CDP proxy listening on ws://localhost:9222");

wss.on("connection", (localWs) => {
  const remoteUrl = `wss://chrome.${DOMAIN}`;
  const remoteWs = new WebSocket(remoteUrl, {
    headers: {
      "x-vm0-token": BRIDGE_TOKEN,
    },
  });

  console.log(`📡 New Chrome CDP connection: ${remoteUrl}`);

  remoteWs.on("open", () => {
    console.log("   Remote WebSocket connected");
  });

  localWs.on("message", (msg) => {
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(msg);
    }
  });

  remoteWs.on("message", (msg) => {
    if (localWs.readyState === WebSocket.OPEN) {
      localWs.send(msg);
    }
  });

  localWs.on("close", () => {
    console.log("   Local WebSocket closed");
    remoteWs.close();
  });

  remoteWs.on("close", () => {
    console.log("   Remote WebSocket closed");
    localWs.close();
  });

  localWs.on("error", (err) => {
    console.error("   Local WebSocket error:", err.message);
  });

  remoteWs.on("error", (err) => {
    console.error("   Remote WebSocket error:", err.message);
  });
});

// WebDAV HTTP Proxy (localhost:18080 → https://webdav.{domain})
const httpServer = http.createServer((req, res) => {
  const targetUrl = `https://webdav.${DOMAIN}${req.url}`;

  console.log(`📁 WebDAV request: ${req.method} ${req.url}`);

  const proxyReq = https.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        "x-vm0-token": BRIDGE_TOKEN,
        host: `webdav.${DOMAIN}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    console.error("   WebDAV proxy error:", err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway");
  });

  req.pipe(proxyReq);
});

httpServer.listen(18080, "127.0.0.1", () => {
  console.log("✅ WebDAV proxy listening on http://localhost:18080");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down proxy...");
  wss.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
});

console.log("\n🚀 Sandbox proxy ready!");
console.log("   Chrome CDP:  ws://localhost:9222");
console.log("   WebDAV:      http://localhost:18080");
console.log("   Press Ctrl+C to stop\n");
