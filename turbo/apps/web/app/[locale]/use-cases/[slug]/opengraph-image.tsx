import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConnectorRef } from "../data";
import { getUseCaseBySlug } from "../data";
import enMessages from "../../../../messages/en.json";
import deMessages from "../../../../messages/de.json";
import jaMessages from "../../../../messages/ja.json";
import esMessages from "../../../../messages/es.json";

export const alt = "VM0 Use Case";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG_COLOR = "#F3F5F8";
const TEXT_COLOR = "#1A1A1F";
const MUTED_COLOR = "#5C5C66";
const TILE_BG = "#FFFFFF";
const TILE_BORDER = "#E2E5EA";

const ZERO_AVATAR_PATH = "assets/zero-avatar.png";

type UseCaseContent = { title?: string; description?: string };
type MessagesShape = {
  useCases?: { content?: Record<string, UseCaseContent> };
};

const ALL_MESSAGES: Record<string, MessagesShape> = {
  en: enMessages as MessagesShape,
  de: deMessages as MessagesShape,
  ja: jaMessages as MessagesShape,
  es: esMessages as MessagesShape,
};

const PUBLIC_DIR = path.join(process.cwd(), "public");
const fontCache = new Map<string, ArrayBuffer>();

function readPublicAsBase64(relPath: string, mime: string): string {
  const cleaned = relPath.replace(/^\//, "");
  const buf = readFileSync(path.join(PUBLIC_DIR, cleaned));
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function readSvgDataUri(relPath: string): string {
  return readPublicAsBase64(relPath, "image/svg+xml");
}

function readPngDataUri(relPath: string): string {
  return readPublicAsBase64(relPath, "image/png");
}

async function loadGoogleFont(
  family: string,
  weight: 400 | 700,
): Promise<ArrayBuffer> {
  const key = `${family}@${weight}`;
  const cached = fontCache.get(key);
  if (cached) return cached;

  const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}&display=swap`;
  const css = await (
    await fetch(cssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    })
  ).text();
  const match = css.match(
    /src:\s*url\(([^)]+)\)\s*format\(['"]?(woff2?|truetype|opentype)['"]?\)/,
  );
  const fontUrl = match?.[1];
  if (!fontUrl) {
    throw new Error(`Failed to extract font URL for ${key}`);
  }
  const buf = await (await fetch(fontUrl)).arrayBuffer();
  fontCache.set(key, buf);
  return buf;
}

function fontFamilyForLocale(locale: string): string {
  return locale === "ja" ? "Noto Sans JP" : "Noto Sans";
}

function resolveContent(locale: string, slug: string): UseCaseContent {
  const primary = ALL_MESSAGES[locale]?.useCases?.content?.[slug];
  if (primary) return primary;
  const fallback = ALL_MESSAGES.en?.useCases?.content?.[slug];
  return fallback ?? {};
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

interface ConnectorTile {
  uri: string;
  label: string;
}

function toConnectorTile(c: ConnectorRef): ConnectorTile {
  return {
    uri: readSvgDataUri(c.icon),
    label: c.label,
  };
}

function renderConnectorTile(c: ConnectorTile) {
  return (
    <div
      key={c.label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 56,
        height: 56,
        borderRadius: 14,
        backgroundColor: TILE_BG,
        border: `1px solid ${TILE_BORDER}`,
      }}
    >
      <img src={c.uri} width={32} height={32} alt="" />
    </div>
  );
}

function renderZeroAvatar() {
  const dim = 280;
  const uri = readPngDataUri(ZERO_AVATAR_PATH);
  return (
    <img src={uri} width={dim} height={dim} style={{ flexShrink: 0 }} alt="" />
  );
}

interface Params {
  params: Promise<{ slug: string; locale: string }>;
}

export default async function OpengraphImage({ params }: Params) {
  const { slug, locale } = await params;
  const useCase = getUseCaseBySlug(slug);

  const content = resolveContent(locale, slug);
  const title = content.title ?? "VM0 Use Case";
  const description = truncate(content.description ?? "", 140);

  const connectors = (useCase?.connectors ?? []).slice(0, 5);

  const family = fontFamilyForLocale(locale);
  const [regular, bold] = await Promise.all([
    loadGoogleFont(family, 400),
    loadGoogleFont(family, 700),
  ]);

  const logoUri = readSvgDataUri("assets/vm0-logo-dark.svg");
  const connectorTiles = connectors.map(toConnectorTile);

  const baseTitleFontSize = locale === "ja" ? 44 : 58;
  const titleFontSize =
    title.length > 80 ? baseTitleFontSize - 6 : baseTitleFontSize;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: BG_COLOR,
        color: TEXT_COLOR,
        padding: "60px 72px",
        fontFamily: family,
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <img src={logoUri} width={130} height={39} alt="" />
      </div>

      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          gap: 56,
          paddingTop: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            gap: 24,
          }}
        >
          <div
            style={{
              display: "-webkit-box",
              fontSize: titleFontSize,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: -1,
              color: TEXT_COLOR,
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: "-webkit-box",
              fontSize: 24,
              fontWeight: 400,
              lineHeight: 1.45,
              color: MUTED_COLOR,
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {description}
          </div>
        </div>
        {renderZeroAvatar()}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {connectorTiles.map(renderConnectorTile)}
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: family, data: regular, weight: 400, style: "normal" },
        { name: family, data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
