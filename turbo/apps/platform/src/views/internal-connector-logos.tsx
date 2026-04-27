import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { useGet, useSet } from "ccstate-react";
import { CONNECTOR_ICONS } from "./zero-page/components/settings/connector-icons.tsx";
import {
  iconSize$,
  iconSizes$,
  setIconSize$,
  type IconSize,
} from "../signals/icon-size.ts";

function getIconType(url: string): string {
  if (url.startsWith("data:image/svg+xml")) {
    return "SVG (inline)";
  }
  if (url.endsWith(".svg")) {
    return "SVG";
  }
  if (url.endsWith(".png")) {
    return "PNG";
  }
  if (url.endsWith(".jpg") || url.endsWith(".jpeg")) {
    return "JPEG";
  }
  if (url.endsWith(".webp")) {
    return "WebP";
  }
  return "unknown";
}

function IconBox({
  src,
  size,
  shape,
  bg,
}: {
  src: string;
  size: number;
  shape: "square" | "circle";
  bg: string;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: bg === "#fff" ? "1px solid red" : undefined,
        borderRadius: shape === "circle" ? "50%" : 0,
        background: bg,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <img
        src={src}
        alt=""
        style={{
          // Circle: inscribed square = diameter / √2 ≈ 70.7%
          width:
            shape === "circle" ? `${(100 / Math.SQRT2).toFixed(2)}%` : "100%",
          height:
            shape === "circle" ? `${(100 / Math.SQRT2).toFixed(2)}%` : "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}

export function InternalConnectorLogos() {
  const size = useGet(iconSize$);
  const sizes = useGet(iconSizes$);
  const setSize = useSet(setIconSize$);
  const connectorTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

  return (
    <div style={{ padding: 32, fontFamily: "monospace", background: "#fff" }}>
      <div
        style={{
          marginBottom: 24,
          display: "flex",
          alignItems: "center",
          gap: 16,
          position: "sticky",
          top: 0,
          background: "#fff",
          padding: "12px 0",
          borderBottom: "1px solid #eee",
          zIndex: 10,
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>
          Connector Logos ({connectorTypes.length})
        </h1>
        <div style={{ display: "flex", gap: 4 }}>
          {sizes.map((s) => {
            return (
              <button
                key={s}
                onClick={() => {
                  return setSize(s as IconSize);
                }}
                style={{
                  padding: "4px 12px",
                  fontSize: 14,
                  border: s === size ? "2px solid #111" : "1px solid #ccc",
                  borderRadius: 4,
                  background: s === size ? "#111" : "#fff",
                  color: s === size ? "#fff" : "#333",
                  cursor: "pointer",
                  fontFamily: "monospace",
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 13, color: "#999" }}>
          {size}x{size}px
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto auto auto auto 1fr",
          gap: "12px 16px",
          alignItems: "center",
        }}
      >
        {/* Header */}
        <span style={{ fontSize: 12, color: "#999", fontWeight: 600 }}>
          Square / white
        </span>
        <span style={{ fontSize: 12, color: "#999", fontWeight: 600 }}>
          Square / purple
        </span>
        <span style={{ fontSize: 12, color: "#999", fontWeight: 600 }}>
          Circle / white
        </span>
        <span style={{ fontSize: 12, color: "#999", fontWeight: 600 }}>
          Circle / purple
        </span>
        <span style={{ fontSize: 12, color: "#999", fontWeight: 600 }}>
          Info
        </span>

        {connectorTypes.map((type) => {
          const iconUrl = CONNECTOR_ICONS[type];
          const iconType = getIconType(iconUrl);
          return (
            <div key={type} style={{ display: "contents" }}>
              <IconBox src={iconUrl} size={size} shape="square" bg="#fff" />
              <IconBox src={iconUrl} size={size} shape="square" bg="#7c3aed" />
              <IconBox src={iconUrl} size={size} shape="circle" bg="#fff" />
              <IconBox src={iconUrl} size={size} shape="circle" bg="#7c3aed" />
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 14, color: "#111", fontWeight: 600 }}>
                  {CONNECTOR_TYPES[type].label}
                </span>
                <span style={{ fontSize: 12, color: "#999" }}>{type}</span>
                <span style={{ fontSize: 12, color: "#666" }}>{iconType}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
