import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getUseCaseBySlug } from "../data";
import enMessages from "../../../../messages/en.json";
import deMessages from "../../../../messages/de.json";
import jaMessages from "../../../../messages/ja.json";
import esMessages from "../../../../messages/es.json";

export const alt = "VM0 Use Case";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

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

type StatsLabels = { steps: string; integrations: string; nextActions: string };

const EN_LABELS: StatsLabels = {
  steps: "steps",
  integrations: "integrations",
  nextActions: "next actions",
};

const STATS_LABELS: Record<string, StatsLabels> = {
  en: EN_LABELS,
  de: {
    steps: "Schritte",
    integrations: "Integrationen",
    nextActions: "Folgeaktionen",
  },
  ja: {
    steps: "ステップ",
    integrations: "連携",
    nextActions: "次のアクション",
  },
  es: {
    steps: "pasos",
    integrations: "integraciones",
    nextActions: "próximas acciones",
  },
};

const EN_USE_CASE_LABEL = "Use case";
const USE_CASE_LABELS: Record<string, string> = {
  en: EN_USE_CASE_LABEL,
  de: "Anwendungsfall",
  ja: "ユースケース",
  es: "Caso de uso",
};

const PUBLIC_DIR = path.join(process.cwd(), "public");
const fontCache = new Map<string, ArrayBuffer>();

function readPublicSvgDataUri(relPath: string): string {
  const cleaned = relPath.replace(/^\//, "");
  const buf = readFileSync(path.join(PUBLIC_DIR, cleaned));
  return `data:image/svg+xml;base64,${buf.toString("base64")}`;
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

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace(/^#/, "");
  let full: string;
  if (cleaned.length === 3) {
    full = "";
    for (const c of cleaned) full += c + c;
  } else {
    full = cleaned;
  }
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

function toConnectorTile(c: { icon: string; label: string }): ConnectorTile {
  return {
    uri: readPublicSvgDataUri(c.icon),
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
        backgroundColor: "#ffffff",
      }}
    >
      <img src={c.uri} width={32} height={32} alt="" />
    </div>
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
  const description = truncate(content.description ?? "", 160);

  const accent = useCase?.color ?? "#ED4E01";
  const connectors = (useCase?.connectors ?? []).slice(0, 5);
  const stepCount = useCase?.stepCount ?? 0;
  const integrationCount = useCase?.integrationCount ?? 0;
  const nextActionCount = useCase?.nextActionCount ?? 0;

  const family = fontFamilyForLocale(locale);
  const [regular, bold] = await Promise.all([
    loadGoogleFont(family, 400),
    loadGoogleFont(family, 700),
  ]);

  const logoUri = readPublicSvgDataUri("assets/vm0-logo.svg");
  const connectorTiles = connectors.map(toConnectorTile);

  const useCaseLabel = USE_CASE_LABELS[locale] ?? EN_USE_CASE_LABEL;
  const labels = STATS_LABELS[locale] ?? EN_LABELS;
  const titleFontSize = title.length > 80 ? 52 : 60;
  const showNextActions = nextActionCount > 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#0b0b0d",
          backgroundImage: `radial-gradient(circle at 0% 0%, ${hexToRgba(accent, 0.32)} 0%, ${hexToRgba(accent, 0.05)} 45%, #0b0b0d 75%)`,
          color: "#fafafa",
          padding: "64px 80px",
          fontFamily: family,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <img src={logoUri} width={120} height={36} alt="" />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: 2,
              color: accent,
              textTransform: "uppercase",
            }}
          >
            {useCaseLabel}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            gap: 28,
            paddingTop: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: titleFontSize,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: -1,
              maxWidth: 1040,
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 400,
              lineHeight: 1.4,
              color: "#a8a8ad",
              maxWidth: 1040,
            }}
          >
            {description}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {connectorTiles.map(renderConnectorTile)}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              fontSize: 22,
              color: "#cfcfd4",
            }}
          >
            <div style={{ display: "flex" }}>
              {stepCount} {labels.steps}
            </div>
            <div style={{ display: "flex", color: "#54545a" }}>·</div>
            <div style={{ display: "flex" }}>
              {integrationCount} {labels.integrations}
            </div>
            {showNextActions ? (
              <div style={{ display: "flex", color: "#54545a" }}>·</div>
            ) : null}
            {showNextActions ? (
              <div style={{ display: "flex" }}>
                {nextActionCount} {labels.nextActions}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: family, data: regular, weight: 400, style: "normal" },
        { name: family, data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
