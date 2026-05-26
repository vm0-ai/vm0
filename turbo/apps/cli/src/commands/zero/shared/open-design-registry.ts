export type OpenDesignTarget =
  | "image"
  | "presentation"
  | "website"
  | "dashboard-design"
  | "mobile-app-design"
  | "poster"
  | "intro-video"
  | "report"
  | "docs-design";

export type GenerationOutputKind =
  | "website"
  | "image"
  | "audio"
  | "video"
  | "presentation"
  | "report"
  | "poster"
  | "dashboard-design"
  | "mobile-app-design"
  | "docs-design"
  | "bundle";

type OpenDesignResourceKind =
  | "skill"
  | "template"
  | "design-system"
  | "image-style"
  | "audio-style"
  | "video-template"
  | "bundle-template";
type OpenDesignResourceStatus = "curated" | "experimental" | "hidden";
type OpenDesignExecutorHint =
  | "agent-authored-html"
  | "built-in-image"
  | "built-in-video"
  | "built-in-voice"
  | "connector-backed"
  | "skill-authored";
type OpenDesignPreviewHint =
  | "hosted-url"
  | "image"
  | "video"
  | "audio"
  | "mixed-directory"
  | "file";
type OpenDesignRemixHint =
  | "prompt"
  | "prompt-with-resource-hints"
  | "source-assets";

interface OpenDesignSourceRef {
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
}

export interface OpenDesignRegistryEntry {
  readonly id: string;
  readonly kind: OpenDesignResourceKind;
  readonly name: string;
  readonly description: string;
  readonly source: OpenDesignSourceRef;
  readonly targets: readonly OpenDesignTarget[];
  readonly tags: readonly string[];
  readonly triggers?: readonly string[];
  readonly bestFor?: readonly string[];
  readonly avoidFor?: readonly string[];
  readonly compatibleWith?: readonly string[];
  readonly outputKinds?: readonly GenerationOutputKind[];
  readonly primaryOutputKind?: GenerationOutputKind;
  readonly supportingOutputKinds?: readonly GenerationOutputKind[];
  readonly executorHints?: readonly OpenDesignExecutorHint[];
  readonly previewHint?: OpenDesignPreviewHint;
  readonly remixHint?: OpenDesignRemixHint;
  readonly status: OpenDesignResourceStatus;
  readonly priority?: number;
}

export interface OpenDesignCandidateSlice {
  readonly registryVersion: string;
  readonly source: {
    readonly repo: string;
    readonly commit: string;
  };
  readonly sources: readonly {
    readonly repo: string;
    readonly commit: string;
  }[];
  readonly candidates: {
    readonly skills: readonly OpenDesignRegistryEntry[];
    readonly templates: readonly OpenDesignRegistryEntry[];
    readonly designSystems: readonly OpenDesignRegistryEntry[];
    readonly imageStyles: readonly OpenDesignRegistryEntry[];
    readonly audioStyles: readonly OpenDesignRegistryEntry[];
    readonly videoTemplates: readonly OpenDesignRegistryEntry[];
    readonly bundleTemplates: readonly OpenDesignRegistryEntry[];
  };
}

const OPEN_DESIGN_REPO = "vm0-ai/open-design";
const OPEN_DESIGN_COMMIT = "d021b04720ace133f1d6133d1487326f5fc28f07";
const VM0_SKILLS_REPO = "vm0-ai/vm0-skills";
const NOTION_ILLUSTRATION_COMMIT = "b35373eb12112b1e7a0caa372a5cafe02e214dd1";

const OPEN_DESIGN_REGISTRY_VERSION = `federated:${OPEN_DESIGN_REPO}@${OPEN_DESIGN_COMMIT}`;

function sourceRef(
  repo: string,
  commit: string,
  path: string,
): OpenDesignSourceRef {
  return {
    repo,
    commit,
    path,
  };
}

function source(path: string): OpenDesignSourceRef {
  return sourceRef(OPEN_DESIGN_REPO, OPEN_DESIGN_COMMIT, path);
}

const OPEN_DESIGN_REGISTRY: readonly OpenDesignRegistryEntry[] = [
  {
    id: "od:skill:data-report",
    kind: "skill",
    name: "Data Report",
    description:
      "Turns source-backed data, rankings, metrics, or lists into a concise analytical report.",
    source: source("skills/data-report/SKILL.md"),
    targets: [
      "presentation",
      "website",
      "dashboard-design",
      "report",
      "docs-design",
    ],
    tags: ["analysis", "data", "report", "ranking", "sources", "table"],
    triggers: ["report", "top 10", "ranking", "metrics", "analysis"],
    bestFor: ["source-backed reports", "ranked lists", "data summaries"],
    status: "curated",
    priority: 40,
  },
  {
    id: "od:skill:article-magazine",
    kind: "skill",
    name: "Article Magazine",
    description:
      "Shapes research or editorial material into a magazine-like narrative with strong hierarchy.",
    source: source("skills/article-magazine/SKILL.md"),
    targets: ["presentation", "website", "poster", "report", "docs-design"],
    tags: ["editorial", "magazine", "article", "narrative", "research"],
    triggers: ["magazine", "editorial", "story", "essay", "briefing"],
    bestFor: [
      "editorial reports",
      "narrative explainers",
      "research synthesis",
    ],
    status: "curated",
    priority: 28,
  },
  {
    id: "od:skill:design-brief",
    kind: "skill",
    name: "Design Brief",
    description:
      "Converts a product, brand, or feature request into a structured design brief.",
    source: source("skills/design-brief/SKILL.md"),
    targets: ["presentation", "website", "mobile-app-design", "docs-design"],
    tags: ["design", "brief", "product", "brand", "requirements"],
    triggers: ["design brief", "brand", "product direction", "requirements"],
    bestFor: ["product design briefs", "brand-driven websites"],
    status: "curated",
    priority: 16,
  },
  {
    id: "od:template:dashboard",
    kind: "template",
    name: "Dashboard",
    description:
      "Dense operational dashboard layout for KPIs, lists, filters, and repeated scanning.",
    source: source("design-templates/dashboard"),
    targets: ["website", "dashboard-design", "report"],
    tags: ["dashboard", "analytics", "kpi", "metrics", "operations", "table"],
    triggers: ["dashboard", "analytics", "monitoring", "metrics", "ops"],
    bestFor: ["metric-heavy pages", "status surfaces", "operational summaries"],
    compatibleWith: ["od:skill:data-report", "od:design-system:dashboard"],
    status: "curated",
    priority: 36,
  },
  {
    id: "od:template:finance-report",
    kind: "template",
    name: "Finance Report",
    description:
      "Executive report layout with tables, callouts, trend blocks, and source notes.",
    source: source("design-templates/finance-report"),
    targets: ["presentation", "website", "report"],
    tags: ["report", "finance", "executive", "table", "analysis", "sources"],
    triggers: ["report", "brief", "analysis", "top 10", "finance"],
    bestFor: ["source-backed reports", "executive summaries", "ranked lists"],
    compatibleWith: ["od:skill:data-report", "od:design-system:dashboard"],
    status: "curated",
    priority: 34,
  },
  {
    id: "od:template:docs-page",
    kind: "template",
    name: "Docs Page",
    description:
      "Documentation-style page layout for structured explanations, navigation, and examples.",
    source: source("design-templates/docs-page"),
    targets: ["website", "docs-design", "report"],
    tags: ["docs", "explanation", "guide", "structured", "reference"],
    triggers: ["docs", "documentation", "guide", "explain", "how to"],
    bestFor: ["technical explainers", "product docs", "implementation notes"],
    compatibleWith: ["od:skill:design-brief", "od:design-system:mono"],
    status: "curated",
    priority: 26,
  },
  {
    id: "od:template:mobile-app",
    kind: "template",
    name: "Mobile App Design",
    description:
      "Single-screen mobile UI design rendered in a realistic iPhone device frame.",
    source: source("design-templates/mobile-app"),
    targets: ["mobile-app-design"],
    tags: ["mobile", "app", "ios", "design", "prototype", "phone"],
    triggers: [
      "mobile app",
      "ios app",
      "android app",
      "phone screen",
      "app ui",
      "app mockup",
    ],
    bestFor: ["mobile UI mockups", "single-screen app design reviews"],
    compatibleWith: ["od:skill:design-brief", "od:design-system:apple"],
    status: "curated",
    priority: 38,
  },
  {
    id: "od:template:html-ppt-graphify-dark-graph",
    kind: "template",
    name: "Graphify Dark Graph",
    description:
      "Dark graph-heavy HTML presentation template for data stories and technical briefings.",
    source: source("design-templates/html-ppt-graphify-dark-graph"),
    targets: ["presentation", "report"],
    tags: ["presentation", "dark", "graph", "data", "technical", "metrics"],
    triggers: ["deck", "presentation", "graph", "dark", "data story"],
    bestFor: ["data presentations", "technical executive briefings"],
    compatibleWith: [
      "od:skill:data-report",
      "od:design-system:trading-terminal",
    ],
    status: "curated",
    priority: 32,
  },
  {
    id: "od:template:html-ppt-zhangzara-retro-zine",
    kind: "template",
    name: "Zhangzara Retro Zine",
    description:
      "Expressive retro editorial HTML presentation template with zine-like composition.",
    source: source("design-templates/html-ppt-zhangzara-retro-zine"),
    targets: ["presentation", "poster", "report"],
    tags: ["presentation", "retro", "zine", "editorial", "expressive"],
    triggers: ["retro", "zine", "editorial", "magazine", "bold"],
    bestFor: [
      "editorial decks",
      "culture reports",
      "visually distinctive summaries",
    ],
    compatibleWith: [
      "od:skill:article-magazine",
      "od:design-system:warm-editorial",
    ],
    status: "curated",
    priority: 30,
  },
  {
    id: "od:template:weekly-update",
    kind: "template",
    name: "Weekly Update",
    description:
      "Compact update deck/page structure for highlights, risks, next steps, and metrics.",
    source: source("design-templates/weekly-update"),
    targets: ["presentation", "report", "docs-design"],
    tags: ["update", "status", "briefing", "report", "metrics"],
    triggers: ["weekly", "status", "update", "briefing"],
    bestFor: ["team updates", "status reports", "progress summaries"],
    compatibleWith: ["od:skill:data-report", "od:design-system:dashboard"],
    status: "curated",
    priority: 24,
  },
  {
    id: "od:template:web-prototype-taste-editorial",
    kind: "template",
    name: "Taste Editorial Web Prototype",
    description:
      "Editorial website prototype direction with image-led sections and strong copy hierarchy.",
    source: source("design-templates/web-prototype-taste-editorial"),
    targets: ["website", "poster"],
    tags: ["website", "editorial", "brand", "visual", "prototype"],
    triggers: ["landing", "site", "brand", "editorial", "launch"],
    bestFor: ["brand websites", "launch pages", "editorial product pages"],
    compatibleWith: ["od:skill:article-magazine", "od:design-system:editorial"],
    status: "curated",
    priority: 30,
  },
  {
    id: "od:design-system:dashboard",
    kind: "design-system",
    name: "Dashboard",
    description:
      "Quiet, dense interface system for dashboards, tables, filters, and repeat workflows.",
    source: source("design-systems/dashboard"),
    targets: ["website", "dashboard-design", "report"],
    tags: ["dashboard", "neutral", "dense", "table", "operations", "charts"],
    triggers: ["dashboard", "analytics", "metrics", "ops", "report"],
    bestFor: ["operational UIs", "data reports", "admin surfaces"],
    status: "curated",
    priority: 36,
  },
  {
    id: "od:design-system:trading-terminal",
    kind: "design-system",
    name: "Trading Terminal",
    description:
      "Dark dense market-terminal aesthetic for charts, feeds, tables, and high information density.",
    source: source("design-systems/trading-terminal"),
    targets: ["presentation", "website", "dashboard-design", "report"],
    tags: ["dark", "terminal", "finance", "data", "charts", "dense"],
    triggers: ["dark", "terminal", "trading", "chart", "graph"],
    bestFor: ["dark analytical reports", "graph-heavy dashboards"],
    status: "curated",
    priority: 32,
  },
  {
    id: "od:design-system:warm-editorial",
    kind: "design-system",
    name: "Warm Editorial",
    description:
      "Warm editorial design system for readable narrative pages, zines, and reports.",
    source: source("design-systems/warm-editorial"),
    targets: ["presentation", "website", "poster", "report", "docs-design"],
    tags: ["warm", "editorial", "magazine", "narrative", "readable"],
    triggers: ["editorial", "magazine", "zine", "warm", "story"],
    bestFor: ["narrative reports", "editorial decks", "long-form pages"],
    status: "curated",
    priority: 30,
  },
  {
    id: "od:design-system:editorial",
    kind: "design-system",
    name: "Editorial",
    description:
      "Clean editorial design system with strong typography, media framing, and section rhythm.",
    source: source("design-systems/editorial"),
    targets: ["presentation", "website", "poster", "report", "docs-design"],
    tags: ["editorial", "typography", "media", "brand", "article"],
    triggers: ["editorial", "article", "brand", "landing", "magazine"],
    bestFor: ["brand sites", "article-style reports", "visual narratives"],
    status: "curated",
    priority: 28,
  },
  {
    id: "od:design-system:mono",
    kind: "design-system",
    name: "Mono",
    description:
      "Minimal monospace-oriented system for documentation, technical pages, and precise reports.",
    source: source("design-systems/mono"),
    targets: ["website", "docs-design", "report"],
    tags: ["mono", "docs", "technical", "minimal", "structured"],
    triggers: ["docs", "technical", "reference", "minimal", "api"],
    bestFor: ["technical documentation", "implementation reports"],
    status: "curated",
    priority: 20,
  },
  {
    id: "od:design-system:apple",
    kind: "design-system",
    name: "Apple",
    description:
      "Apple-inspired interface system for polished mobile and product UI design.",
    source: source("design-systems/apple"),
    targets: ["mobile-app-design", "website"],
    tags: ["apple", "mobile", "ios", "clean", "product"],
    triggers: ["mobile", "ios", "iphone", "app design", "app ui"],
    bestFor: ["phone-framed product mocks", "consumer mobile UI"],
    status: "curated",
    priority: 34,
  },
  {
    id: "vm0:image-style:notion-illustration",
    kind: "image-style",
    name: "Notion Illustration",
    description:
      "Zero-native illustration style for hand-drawn product spot illustrations with simple ink contours and soft backgrounds.",
    source: sourceRef(
      VM0_SKILLS_REPO,
      NOTION_ILLUSTRATION_COMMIT,
      "notion-illustration",
    ),
    targets: ["image", "website", "poster", "presentation", "report"],
    tags: ["image", "illustration", "notion", "spot", "hand-drawn", "product"],
    triggers: [
      "illustration",
      "notion illustration",
      "spot illustration",
      "hand drawn",
      "product illustration",
    ],
    bestFor: [
      "in-app empty states",
      "gallery previews",
      "product narrative artwork",
    ],
    outputKinds: ["image"],
    primaryOutputKind: "image",
    executorHints: ["skill-authored", "built-in-image"],
    previewHint: "image",
    remixHint: "prompt-with-resource-hints",
    status: "experimental",
    priority: 18,
  },
];

export function toOpenDesignTarget(value: string): OpenDesignTarget {
  if (value === "dashboard") {
    return "dashboard-design";
  }

  if (value === "docs") {
    return "docs-design";
  }

  if (value === "mobile-app") {
    return "mobile-app-design";
  }

  return value as OpenDesignTarget;
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function tokenize(value: string): readonly string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/u)
    .filter((token) => {
      return token.length >= 2;
    });
}

function phraseScore(
  values: readonly string[] | undefined,
  prompt: string,
  weight: number,
): number {
  if (!values) {
    return 0;
  }

  return values.reduce((score, value) => {
    return prompt.includes(normalizeText(value)) ? score + weight : score;
  }, 0);
}

function tokenScore(
  values: readonly string[] | undefined,
  promptTokens: Set<string>,
  weight: number,
): number {
  if (!values) {
    return 0;
  }

  return values.reduce((score, value) => {
    const matches = tokenize(value).filter((token) => {
      return promptTokens.has(token);
    });
    return score + matches.length * weight;
  }, 0);
}

function scoreEntry(
  entry: OpenDesignRegistryEntry,
  target: OpenDesignTarget,
  prompt: string,
): number {
  const normalizedPrompt = normalizeText(prompt);
  const promptTokens = new Set(tokenize(prompt));
  const targetScore = entry.targets.includes(target) ? 100 : 0;
  const curationScore =
    entry.status === "curated"
      ? 20
      : entry.status === "experimental"
        ? -20
        : -1000;

  return (
    targetScore +
    curationScore +
    (entry.priority ?? 0) +
    phraseScore(entry.triggers, normalizedPrompt, 40) +
    phraseScore(entry.bestFor, normalizedPrompt, 15) +
    tokenScore(entry.tags, promptTokens, 10) +
    tokenScore(entry.description.split(" "), promptTokens, 2)
  );
}

function selectByKind(
  kind: OpenDesignResourceKind,
  target: OpenDesignTarget,
  prompt: string,
  limit: number,
): readonly OpenDesignRegistryEntry[] {
  return OPEN_DESIGN_REGISTRY.filter((entry) => {
    return entry.kind === kind && entry.status !== "hidden";
  })
    .map((entry) => {
      return { entry, score: scoreEntry(entry, target, prompt) };
    })
    .filter(({ score }) => {
      return score > 0;
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.entry.id.localeCompare(right.entry.id);
    })
    .slice(0, limit)
    .map(({ entry }) => {
      return entry;
    });
}

export function selectOpenDesignCandidates(options: {
  readonly target: OpenDesignTarget;
  readonly prompt: string;
  readonly limitPerKind?: number;
}): OpenDesignCandidateSlice {
  const limitPerKind = options.limitPerKind ?? 8;

  return {
    registryVersion: OPEN_DESIGN_REGISTRY_VERSION,
    source: {
      repo: OPEN_DESIGN_REPO,
      commit: OPEN_DESIGN_COMMIT,
    },
    sources: [
      {
        repo: OPEN_DESIGN_REPO,
        commit: OPEN_DESIGN_COMMIT,
      },
      {
        repo: VM0_SKILLS_REPO,
        commit: NOTION_ILLUSTRATION_COMMIT,
      },
    ],
    candidates: {
      skills: selectByKind(
        "skill",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      templates: selectByKind(
        "template",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      designSystems: selectByKind(
        "design-system",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      imageStyles: selectByKind(
        "image-style",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      audioStyles: selectByKind(
        "audio-style",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      videoTemplates: selectByKind(
        "video-template",
        options.target,
        options.prompt,
        limitPerKind,
      ),
      bundleTemplates: selectByKind(
        "bundle-template",
        options.target,
        options.prompt,
        limitPerKind,
      ),
    },
  };
}
