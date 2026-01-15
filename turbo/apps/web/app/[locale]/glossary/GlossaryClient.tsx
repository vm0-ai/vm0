"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

interface TermConfig {
  key: string;
  category: string;
  relatedTerms?: string[];
}

// Term configuration (language-independent)
const termConfigs: TermConfig[] = [
  {
    key: "agent",
    category: "Core Concepts",
    relatedTerms: ["tool", "skill", "session"],
  },
  { key: "skill", category: "Core Concepts", relatedTerms: ["tool", "agent"] },
  { key: "tool", category: "Core Concepts", relatedTerms: ["skill", "agent"] },
  {
    key: "prompt",
    category: "Core Concepts",
    relatedTerms: ["agent", "context"],
  },
  {
    key: "context",
    category: "Core Concepts",
    relatedTerms: ["session", "memory", "agent"],
  },
  {
    key: "session",
    category: "Execution",
    relatedTerms: ["context", "checkpoint"],
  },
  {
    key: "checkpoint",
    category: "Execution",
    relatedTerms: ["session", "artifact"],
  },
  { key: "artifact", category: "Execution", relatedTerms: ["checkpoint"] },
  { key: "observability", category: "Infrastructure", relatedTerms: ["agent"] },
  {
    key: "sandbox",
    category: "Infrastructure",
    relatedTerms: ["agent", "session"],
  },
  {
    key: "memory",
    category: "Core Concepts",
    relatedTerms: ["context", "session"],
  },
  { key: "workflow", category: "Development", relatedTerms: ["agent"] },
  { key: "llm", category: "Core Concepts", relatedTerms: ["agent"] },
  { key: "skillMd", category: "Development", relatedTerms: ["skill", "agent"] },
  { key: "agentMd", category: "Development", relatedTerms: ["agent", "skill"] },
  {
    key: "volume",
    category: "Infrastructure",
    relatedTerms: ["artifact", "session"],
  },
  {
    key: "action",
    category: "Execution",
    relatedTerms: ["tool", "agent", "workflow"],
  },
  {
    key: "runtime",
    category: "Infrastructure",
    relatedTerms: ["sandbox", "agent", "session"],
  },
  {
    key: "orchestration",
    category: "Development",
    relatedTerms: ["agent", "workflow"],
  },
  {
    key: "mcp",
    category: "Core Concepts",
    relatedTerms: ["tool", "agent", "skill"],
  },
  {
    key: "image",
    category: "Infrastructure",
    relatedTerms: ["runtime", "sandbox"],
  },
  {
    key: "secrets",
    category: "Infrastructure",
    relatedTerms: ["environmentVariable", "agent"],
  },
  {
    key: "environmentVariable",
    category: "Infrastructure",
    relatedTerms: ["secrets", "runtime"],
  },
  {
    key: "virtualMachine",
    category: "Infrastructure",
    relatedTerms: ["sandbox", "runtime", "image"],
  },
  { key: "cli", category: "Development", relatedTerms: ["cliAgent", "agent"] },
  {
    key: "cliAgent",
    category: "Core Concepts",
    relatedTerms: ["cli", "agent"],
  },
  {
    key: "agentRouter",
    category: "Infrastructure",
    relatedTerms: ["agent", "llm", "orchestration"],
  },
  {
    key: "claudeCode",
    category: "Development",
    relatedTerms: ["cli", "agent", "cliAgent"],
  },
  {
    key: "codex",
    category: "Development",
    relatedTerms: ["cli", "agent", "claudeCode"],
  },
];

export default function GlossaryClient() {
  const t = useTranslations("glossary");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  // Build terms from translations
  const glossaryTerms = useMemo(() => {
    return termConfigs.map((config) => ({
      term: t(`terms.${config.key}.name`),
      definition: t(`terms.${config.key}.definition`),
      category: config.category,
      relatedTerms: config.relatedTerms?.map((key) => t(`terms.${key}.name`)),
      key: config.key,
    }));
  }, [t]);

  const categories = [
    "all",
    ...Array.from(new Set(glossaryTerms.map((term) => term.category))).sort(),
  ];

  const filteredTerms = glossaryTerms.filter((term) => {
    const matchesSearch =
      term.term.toLowerCase().includes(searchQuery.toLowerCase()) ||
      term.definition.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory =
      selectedCategory === "all" || term.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  // Group terms alphabetically
  const groupedTerms = filteredTerms.reduce(
    (acc, term) => {
      const firstLetter = term.term[0]!.toUpperCase();
      if (!acc[firstLetter]) {
        acc[firstLetter] = [];
      }
      acc[firstLetter]!.push(term);
      return acc;
    },
    {} as Record<string, typeof glossaryTerms>,
  );

  return (
    <>
      <Navbar />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "60px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">{t("hero.title")}</h1>
            <p className="hero-description">{t("hero.description")}</p>

            {/* Stats */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "32px",
                marginTop: "24px",
                fontSize: "14px",
                color: "var(--text-muted)",
                fontFamily: '"Noto Sans", sans-serif',
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "var(--primary)",
                  }}
                />
                <span>{glossaryTerms.length} Terms</span>
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "var(--primary)",
                  }}
                />
                <span>{categories.length - 1} Categories</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Search and Filter */}
      <section style={{ padding: "40px 0" }}>
        <div className="container">
          <div>
            {/* Search Box */}
            <div style={{ marginBottom: "40px" }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  background: "var(--card-bg)",
                  border: "1px solid var(--border-light)",
                  borderRadius: "12px",
                  padding: "24px",
                }}
              >
                {/* Search Input */}
                <div style={{ position: "relative" }}>
                  <input
                    type="text"
                    placeholder={t("search.placeholder")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="glossary-search-input"
                    style={{
                      width: "100%",
                      padding: "10px 16px",
                      paddingRight: "40px",
                      background: "var(--code-input-bg)",
                      border: "1px solid var(--code-input-border)",
                      borderRadius: "6px",
                      color: "var(--text-primary)",
                      fontFamily: '"Fira Mono", monospace',
                      fontSize: "14px",
                      transition: "border-color 0.2s ease",
                    }}
                  />
                  <svg
                    style={{
                      position: "absolute",
                      right: "12px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: "16px",
                      height: "16px",
                      color: "var(--text-muted)",
                      pointerEvents: "none",
                    }}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>

                {/* Category Filter */}
                <div style={{ position: "relative" }}>
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="glossary-category-select"
                    style={{
                      width: "100%",
                      padding: "10px 40px 10px 16px",
                      background: "var(--code-input-bg)",
                      border: "1px solid var(--code-input-border)",
                      borderRadius: "6px",
                      color: "var(--text-secondary)",
                      fontFamily: '"Fira Mono", monospace',
                      fontSize: "14px",
                      cursor: "pointer",
                      appearance: "none",
                      transition: "border-color 0.2s ease",
                    }}
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category === "all"
                          ? t("search.allCategories")
                          : t(`categories.${category}`)}
                      </option>
                    ))}
                  </select>
                  <svg
                    style={{
                      position: "absolute",
                      right: "14px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: "14px",
                      height: "14px",
                      color: "var(--text-muted)",
                      pointerEvents: "none",
                    }}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Results Count */}
            <p
              style={{
                textAlign: "center",
                marginBottom: "0",
                color: "var(--text-muted)",
                fontFamily: '"Noto Sans", sans-serif',
                fontSize: "14px",
              }}
            >
              {filteredTerms.length === glossaryTerms.length
                ? `${t("search.showingAll")} ${filteredTerms.length} ${t("search.results")}`
                : `${t("search.found")} ${filteredTerms.length} ${t("search.results")}`}
            </p>
          </div>

          {/* Glossary Terms */}
          {filteredTerms.length > 0 ? (
            <div style={{ marginTop: "40px" }}>
              {Object.keys(groupedTerms)
                .sort()
                .map((letter) => (
                  <div key={letter} style={{ marginBottom: "48px" }}>
                    {/* Letter Header */}
                    <h2
                      style={{
                        fontSize: "28px",
                        fontWeight: "600",
                        color: "var(--text-primary)",
                        marginBottom: "24px",
                        fontFamily: '"Noto Sans", sans-serif',
                      }}
                    >
                      {letter}
                    </h2>

                    {/* Terms */}
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "20px",
                      }}
                    >
                      {groupedTerms[letter]!.map((term) => (
                        <div
                          key={term.key}
                          className="glossary-card"
                          style={{
                            background: "var(--card-bg)",
                            border: "1px solid var(--border-light)",
                            borderRadius: "16px",
                            padding: "24px",
                            transition: "all 0.3s ease",
                          }}
                        >
                          {/* Category Badge */}
                          <div style={{ marginBottom: "12px" }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "4px 10px",
                                fontSize: "12px",
                                fontFamily: '"Fira Mono", monospace',
                                fontWeight: 500,
                                background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                                borderRadius: "4px",
                              }}
                            >
                              {t(`categories.${term.category}`)}
                            </span>
                          </div>

                          {/* Term Name */}
                          <h3
                            style={{
                              fontFamily: '"Noto Sans", sans-serif',
                              fontSize: "20px",
                              fontWeight: 600,
                              marginBottom: "12px",
                              color: "var(--text-primary)",
                            }}
                          >
                            {term.term}
                          </h3>

                          {/* Definition */}
                          <p
                            style={{
                              fontFamily: '"Noto Sans", sans-serif',
                              fontSize: "15px",
                              color: "var(--text-secondary)",
                              lineHeight: 1.6,
                              marginBottom:
                                term.relatedTerms &&
                                term.relatedTerms.length > 0
                                  ? "20px"
                                  : "0",
                            }}
                          >
                            {term.definition}
                          </p>

                          {/* Related Terms */}
                          {term.relatedTerms &&
                            term.relatedTerms.length > 0 && (
                              <div
                                style={{
                                  paddingTop: "16px",
                                  borderTop: "1px solid var(--border-light)",
                                }}
                              >
                                <p
                                  style={{
                                    fontSize: "12px",
                                    color: "var(--text-muted)",
                                    fontFamily: '"Fira Mono", monospace',
                                    marginBottom: "8px",
                                    fontWeight: 500,
                                  }}
                                >
                                  {t("relatedTerms")}
                                </p>
                                <div
                                  style={{
                                    display: "flex",
                                    gap: "8px",
                                    flexWrap: "wrap",
                                  }}
                                >
                                  {term.relatedTerms.map((relatedTerm) => (
                                    <span
                                      key={relatedTerm}
                                      style={{
                                        padding: "4px 10px",
                                        borderRadius: "4px",
                                        background: "var(--bg-tertiary)",
                                        color: "var(--text-secondary)",
                                        fontSize: "12px",
                                        fontFamily: '"Fira Mono", monospace',
                                        fontWeight: 500,
                                      }}
                                    >
                                      {relatedTerm}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div
              style={{
                textAlign: "center",
                padding: "80px 0",
                color: "var(--text-secondary)",
                fontFamily: '"Noto Sans", sans-serif',
                fontSize: "16px",
              }}
            >
              <p>{t("search.noResults")}</p>
            </div>
          )}
        </div>
      </section>

      <Footer />
    </>
  );
}
