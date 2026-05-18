import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ZeroWebsiteSiteData,
  ZeroWebsiteTemplateId,
} from "@vm0/api-contracts/contracts/zero-website-io-generate";

type WebsiteCta = ZeroWebsiteSiteData["primaryCta"];

interface BuildGeneratedWebsiteOptions {
  readonly outDir: string;
  readonly templateId: ZeroWebsiteTemplateId;
  readonly siteData: ZeroWebsiteSiteData;
}

interface WebsiteProps {
  readonly data: ZeroWebsiteSiteData;
  readonly templateId: ZeroWebsiteTemplateId;
}

interface CtaLinkProps {
  readonly cta: WebsiteCta;
  readonly className: string;
  readonly fallbackHref: string;
}

function h(
  type: React.ElementType,
  props: Record<string, unknown> | null,
  ...children: ReactNode[]
): ReactNode {
  return React.createElement(type, props, ...children);
}

function normalizeHref(href: string, fallback: string): string {
  return /^#[a-z0-9-]+$/u.test(href) ? href : fallback;
}

function CtaLink(props: CtaLinkProps): ReactNode {
  return h(
    "a",
    {
      className: props.className,
      href: normalizeHref(props.cta.href, props.fallbackHref),
    },
    props.cta.label,
  );
}

function SectionList(props: { readonly data: ZeroWebsiteSiteData }): ReactNode {
  return h(
    "section",
    { className: "section-band", id: "details" },
    h(
      "div",
      { className: "section-grid" },
      ...props.data.sections.map((section, index) => {
        return h(
          "article",
          { className: "section-block", key: `${section.title}-${index}` },
          h("p", { className: "kicker" }, section.kicker),
          h("h2", null, section.title),
          h("p", { className: "section-copy" }, section.body),
          section.bullets.length > 0
            ? h(
                "ul",
                null,
                ...section.bullets.map((bullet) => {
                  return h("li", { key: bullet }, bullet);
                }),
              )
            : null,
        );
      }),
    ),
  );
}

function Highlights(props: { readonly data: ZeroWebsiteSiteData }): ReactNode {
  return h(
    "section",
    { className: "highlights", id: "features" },
    ...props.data.highlights.map((highlight, index) => {
      return h(
        "article",
        { className: "highlight-card", key: `${highlight.title}-${index}` },
        h(
          "span",
          { className: "card-index" },
          String(index + 1).padStart(2, "0"),
        ),
        h("h3", null, highlight.title),
        h("p", null, highlight.body),
      );
    }),
  );
}

function Stats(props: { readonly data: ZeroWebsiteSiteData }): ReactNode {
  if (props.data.stats.length === 0) {
    return null;
  }
  return h(
    "section",
    { className: "stats", "aria-label": "Key stats" },
    ...props.data.stats.map((stat) => {
      return h(
        "div",
        { className: "stat", key: `${stat.value}-${stat.label}` },
        h("strong", null, stat.value),
        h("span", null, stat.label),
      );
    }),
  );
}

function LaunchTemplate(props: {
  readonly data: ZeroWebsiteSiteData;
}): ReactNode {
  const data = props.data;
  return h(
    React.Fragment,
    null,
    h(
      "section",
      { className: "hero hero-launch", id: "top" },
      h(
        "div",
        { className: "hero-copy" },
        h("p", { className: "kicker" }, data.eyebrow),
        h("h1", null, data.headline),
        h("p", { className: "lead" }, data.subhead),
        h(
          "div",
          { className: "cta-row" },
          h(CtaLink, {
            cta: data.primaryCta,
            className: "button primary",
            fallbackHref: "#contact",
          }),
          h(CtaLink, {
            cta: data.secondaryCta,
            className: "button secondary",
            fallbackHref: "#features",
          }),
        ),
      ),
      h(
        "div",
        { className: "hero-panel", "aria-hidden": "true" },
        h("span", { className: "panel-label" }, data.siteName),
        h(
          "div",
          { className: "panel-stack" },
          ...data.highlights.slice(0, 3).map((highlight) => {
            return h(
              "div",
              { className: "panel-line", key: highlight.title },
              h("strong", null, highlight.title),
              h("span", null, highlight.body),
            );
          }),
        ),
      ),
    ),
    h(Highlights, { data }),
    h(Stats, { data }),
    h(SectionList, { data }),
  );
}

function ProfileTemplate(props: {
  readonly data: ZeroWebsiteSiteData;
}): ReactNode {
  const data = props.data;
  return h(
    React.Fragment,
    null,
    h(
      "section",
      { className: "hero hero-profile", id: "top" },
      h(
        "div",
        { className: "profile-mark", "aria-hidden": "true" },
        data.siteName.slice(0, 2).toUpperCase(),
      ),
      h(
        "div",
        { className: "hero-copy" },
        h("p", { className: "kicker" }, data.eyebrow),
        h("h1", null, data.headline),
        h("p", { className: "lead" }, data.subhead),
        h(
          "div",
          { className: "cta-row" },
          h(CtaLink, {
            cta: data.primaryCta,
            className: "button primary",
            fallbackHref: "#contact",
          }),
          h(CtaLink, {
            cta: data.secondaryCta,
            className: "button secondary",
            fallbackHref: "#details",
          }),
        ),
      ),
    ),
    h(Stats, { data }),
    h(Highlights, { data }),
    h(SectionList, { data }),
  );
}

function WebsiteDocument(props: WebsiteProps): ReactNode {
  const { data, templateId } = props;
  const template =
    templateId === "profile"
      ? h(ProfileTemplate, { data })
      : h(LaunchTemplate, { data });

  return h(
    "html",
    { lang: "en" },
    h(
      "head",
      null,
      h("meta", { charSet: "utf-8" }),
      h("meta", {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      }),
      h("title", null, data.siteName),
      h("meta", { name: "description", content: data.subhead }),
      h("link", { rel: "stylesheet", href: "/assets/styles.css" }),
    ),
    h(
      "body",
      { className: `theme-${data.theme.accent} tone-${data.theme.tone}` },
      h(
        "header",
        { className: "topbar" },
        h("a", { className: "brand", href: "#top" }, data.siteName),
        h(
          "nav",
          { "aria-label": "Primary navigation" },
          h("a", { href: "#features" }, "Features"),
          h("a", { href: "#details" }, "Details"),
          h("a", { href: "#contact" }, "Contact"),
        ),
      ),
      h("main", null, template),
      h(
        "footer",
        { className: "footer", id: "contact" },
        h(
          "div",
          null,
          h("h2", null, data.footer.title),
          h("p", null, data.footer.body),
        ),
        h(CtaLink, {
          cta: data.footer.cta,
          className: "button primary",
          fallbackHref: "#top",
        }),
      ),
    ),
  );
}

const WEBSITE_CSS = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f7f4;
  color: #171717;
  letter-spacing: 0;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-width: 320px;
  background: var(--bg);
  color: var(--text);
}

.theme-cobalt {
  --bg: #f7f7f4;
  --surface: #ffffff;
  --text: #151515;
  --muted: #555c66;
  --line: #d9ddd6;
  --accent: #1457d9;
  --accent-contrast: #ffffff;
  --accent-soft: #e8eefc;
  --secondary: #16836b;
}

.theme-green {
  --bg: #f6f7f2;
  --surface: #ffffff;
  --text: #101611;
  --muted: #526058;
  --line: #d6ddd2;
  --accent: #177a55;
  --accent-contrast: #ffffff;
  --accent-soft: #e7f2ec;
  --secondary: #b6452b;
}

.theme-coral {
  --bg: #f8f7f3;
  --surface: #ffffff;
  --text: #171513;
  --muted: #635b56;
  --line: #ded8d1;
  --accent: #d94f35;
  --accent-contrast: #ffffff;
  --accent-soft: #f7e7e1;
  --secondary: #176a78;
}

.theme-mono {
  --bg: #f6f6f5;
  --surface: #ffffff;
  --text: #111111;
  --muted: #5f5f5f;
  --line: #dadad7;
  --accent: #111111;
  --accent-contrast: #ffffff;
  --accent-soft: #ececea;
  --secondary: #6d6d68;
}

.tone-dark {
  color-scheme: dark;
  --bg: #111411;
  --surface: #191d19;
  --text: #f3f4ef;
  --muted: #b8bdb4;
  --line: #30382f;
  --accent-soft: #23342c;
}

a {
  color: inherit;
  text-decoration: none;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 64px;
  padding: 0 clamp(20px, 5vw, 72px);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 82%, transparent);
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(16px);
}

.brand {
  font-weight: 760;
  overflow-wrap: anywhere;
}

nav {
  display: flex;
  gap: clamp(14px, 3vw, 28px);
  color: var(--muted);
  font-size: 0.95rem;
}

nav a:hover {
  color: var(--text);
}

.hero {
  min-height: 76vh;
  display: grid;
  gap: clamp(32px, 6vw, 72px);
  align-items: center;
  padding: clamp(56px, 9vw, 104px) clamp(20px, 5vw, 72px) clamp(40px, 7vw, 76px);
}

.hero-launch {
  grid-template-columns: minmax(0, 1.08fr) minmax(280px, 0.72fr);
}

.hero-profile {
  grid-template-columns: minmax(170px, 0.32fr) minmax(0, 1fr);
}

.hero-copy {
  max-width: 820px;
}

.kicker {
  margin: 0 0 14px;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  overflow-wrap: anywhere;
}

h1 {
  margin: 0;
  max-width: 880px;
  font-size: clamp(3rem, 9vw, 7.4rem);
  line-height: 0.95;
  font-weight: 820;
}

.lead {
  max-width: 720px;
  margin: 28px 0 0;
  color: var(--muted);
  font-size: clamp(1.08rem, 2vw, 1.35rem);
  line-height: 1.55;
}

.cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  padding: 0 18px;
  font-weight: 750;
  line-height: 1.1;
}

.button.primary {
  background: var(--accent);
  color: var(--accent-contrast);
}

.button.secondary {
  border: 1px solid var(--line);
  color: var(--text);
  background: var(--surface);
}

.hero-panel {
  align-self: stretch;
  min-height: 420px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 22px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.panel-label {
  color: var(--muted);
  font-size: 0.86rem;
  font-weight: 750;
}

.panel-stack {
  display: grid;
  gap: 12px;
}

.panel-line {
  border-left: 4px solid var(--accent);
  padding: 14px 0 14px 16px;
  background: var(--accent-soft);
}

.panel-line strong,
.panel-line span {
  display: block;
}

.panel-line span {
  margin-top: 6px;
  color: var(--muted);
  line-height: 1.45;
}

.profile-mark {
  width: min(26vw, 220px);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: clamp(3rem, 10vw, 7rem);
  font-weight: 850;
}

.highlights,
.stats,
.section-band,
.footer {
  padding: clamp(36px, 6vw, 72px) clamp(20px, 5vw, 72px);
}

.highlights {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.highlight-card {
  min-height: 220px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 22px;
}

.card-index {
  color: var(--secondary);
  font-weight: 800;
  font-size: 0.78rem;
}

.highlight-card h3 {
  margin: 42px 0 12px;
  font-size: 1.35rem;
}

.highlight-card p,
.section-copy,
.footer p {
  color: var(--muted);
  line-height: 1.58;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: var(--line);
}

.stat {
  min-height: 132px;
  background: var(--surface);
  padding: 22px;
}

.stat strong,
.stat span {
  display: block;
}

.stat strong {
  font-size: clamp(1.65rem, 4vw, 3.2rem);
  line-height: 1;
}

.stat span {
  margin-top: 10px;
  color: var(--muted);
}

.section-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(18px, 4vw, 44px);
}

.section-block {
  border-top: 1px solid var(--line);
  padding-top: 22px;
}

.section-block h2 {
  margin: 0;
  font-size: clamp(1.8rem, 4vw, 3.7rem);
  line-height: 1;
}

.section-block ul {
  display: grid;
  gap: 8px;
  margin: 22px 0 0;
  padding: 0;
  list-style: none;
}

.section-block li {
  padding-left: 18px;
  position: relative;
  color: var(--text);
}

.section-block li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.72em;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
}

.footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 24px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.footer h2 {
  margin: 0;
  font-size: clamp(2rem, 5vw, 4rem);
  line-height: 1;
}

.footer p {
  max-width: 720px;
}

@media (max-width: 900px) {
  .topbar {
    align-items: flex-start;
    flex-direction: column;
    justify-content: center;
    padding-top: 14px;
    padding-bottom: 14px;
  }

  nav {
    flex-wrap: wrap;
  }

  .hero-launch,
  .hero-profile,
  .section-grid,
  .footer {
    grid-template-columns: 1fr;
  }

  .hero {
    min-height: auto;
  }

  .hero-panel {
    min-height: 300px;
  }

  .highlights,
  .stats {
    grid-template-columns: 1fr;
  }

  .profile-mark {
    width: min(44vw, 190px);
  }
}

@media (max-width: 520px) {
  h1 {
    font-size: clamp(2.6rem, 17vw, 4.2rem);
  }

  .button {
    width: 100%;
  }
}
`;

export async function buildGeneratedWebsite(
  options: BuildGeneratedWebsiteOptions,
): Promise<void> {
  const assetsDir = join(options.outDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  const markup = renderToStaticMarkup(
    React.createElement(WebsiteDocument, {
      data: options.siteData,
      templateId: options.templateId,
    }),
  );

  await writeFile(
    join(options.outDir, "index.html"),
    `<!doctype html>${markup}`,
  );
  await writeFile(join(assetsDir, "styles.css"), WEBSITE_CSS.trimStart());
}
