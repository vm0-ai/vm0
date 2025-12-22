"use client";

import { useEffect, useState } from "react";
import type { JSX } from "react";
import Image from "next/image";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import Particles from "../cookbooks/Particles";

interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
}

interface SkillsResponse {
  success: boolean;
  total: number;
  categories: number;
  skillsByCategory: Record<string, SkillMetadata[]>;
  skills: SkillMetadata[];
}

export default function SkillsPage() {
  const [skillsData, setSkillsData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  useEffect(() => {
    fetchSkills();
  }, []);

  async function fetchSkills() {
    try {
      const response = await fetch("/api/skills");
      const data = await response.json();
      setSkillsData(data);
    } catch (error) {
      console.error("Failed to fetch skills:", error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <>
        <Particles />
        <Navbar />
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                display: "inline-block",
                width: "32px",
                height: "32px",
                border: "3px solid var(--border-light)",
                borderTopColor: "var(--primary)",
                borderRadius: "50%",
                animation: "spin 1s linear infinite",
              }}
            />
            <p
              style={{
                marginTop: "16px",
                color: "var(--text-secondary)",
                fontFamily: '"Noto Sans", sans-serif',
                fontSize: "14px",
              }}
            >
              Loading skills...
            </p>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  if (!skillsData || !skillsData.success) {
    return (
      <>
        <Particles />
        <Navbar />
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <p
              style={{
                color: "var(--text-secondary)",
                fontFamily: '"Noto Sans", sans-serif',
                fontSize: "16px",
              }}
            >
              Failed to load skills
            </p>
            <button
              onClick={fetchSkills}
              style={{
                marginTop: "16px",
                padding: "8px 16px",
                fontFamily: '"Noto Sans", sans-serif',
                fontSize: "14px",
                fontWeight: 500,
                borderRadius: "4px",
                background: "var(--primary)",
                color: "white",
                border: "none",
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  const categories = [
    "all",
    ...Object.keys(skillsData.skillsByCategory).sort(),
  ];

  const filteredSkills = skillsData.skills.filter((skill) => {
    const matchesSearch =
      skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory =
      selectedCategory === "all" || skill.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <>
      {/* Particles Background */}
      <Particles />

      <Navbar />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "80px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">VM0 Skills</h1>
            <p className="hero-description">
              Pre-built integrations for AI agents. Connect to 50+ services with
              zero configuration.
            </p>

            {/* Stats */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "32px",
                marginTop: "24px",
                marginBottom: "40px",
                fontSize: "14px",
                color: "var(--text-muted)",
                fontFamily: '"Noto Sans", sans-serif',
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "var(--primary)",
                  }}
                />
                <span>{skillsData.total} Skills</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "var(--primary)",
                  }}
                />
                <span>{skillsData.categories} Categories</span>
              </div>
            </div>

            {/* Search and Filter */}
            <div style={{ maxWidth: "800px", margin: "0 auto 40px" }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                }}
              >
                {/* Search Input */}
                <div style={{ flex: 1, position: "relative" }}>
                  <input
                    type="text"
                    placeholder="Search skills..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "12px 16px",
                      paddingRight: "40px",
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border-light)",
                      borderRadius: "4px",
                      color: "var(--text-primary)",
                      fontFamily: '"Noto Sans", sans-serif',
                      fontSize: "14px",
                    }}
                  />
                  <svg
                    style={{
                      position: "absolute",
                      right: "12px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: "18px",
                      height: "18px",
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
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  style={{
                    padding: "12px 16px",
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-light)",
                    borderRadius: "4px",
                    color: "var(--text-primary)",
                    fontFamily: '"Noto Sans", sans-serif',
                    fontSize: "14px",
                    cursor: "pointer",
                    minWidth: "180px",
                  }}
                >
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category === "all" ? "All Categories" : category}
                    </option>
                  ))}
                </select>
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
              {filteredSkills.length === skillsData.total
                ? `Showing all ${filteredSkills.length} skills`
                : `Found ${filteredSkills.length} skills`}
            </p>
          </div>
        </div>
      </section>

      {/* Skills Grid */}
      <section className="section-spacing" style={{ paddingTop: 0 }}>
        <div className="container">
          {filteredSkills.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "80px 0",
                color: "var(--text-secondary)",
                fontFamily: '"Noto Sans", sans-serif',
                fontSize: "16px",
              }}
            >
              <p>No skills found matching your criteria</p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: "24px",
              }}
            >
              {filteredSkills.map((skill) => (
                <a
                  key={skill.name}
                  href={skill.docsUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="skill-card"
                  style={{
                    display: "block",
                    background: "var(--card-bg)",
                    border: "1px solid var(--border-light)",
                    borderRadius: "16px",
                    padding: "24px",
                    textDecoration: "none",
                    color: "inherit",
                    transition: "all 0.3s ease",
                  }}
                >
                  {/* Logo and Category */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      marginBottom: "16px",
                    }}
                  >
                    <div
                      style={{
                        width: "48px",
                        height: "48px",
                        borderRadius: "6px",
                        background: "var(--bg-tertiary)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                        flexShrink: 0,
                      }}
                    >
                      {skill.logo ? (
                        <Image
                          src={skill.logo}
                          alt={skill.name}
                          width={32}
                          height={32}
                          unoptimized
                        />
                      ) : (
                        <svg
                          style={{
                            width: "24px",
                            height: "24px",
                            color: "var(--text-muted)",
                          }}
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                        </svg>
                      )}
                    </div>
                    <span
                      style={{
                        padding: "4px 10px",
                        fontSize: "12px",
                        fontFamily: '"Noto Sans", sans-serif',
                        fontWeight: 500,
                        background: "var(--bg-tertiary)",
                        color: "var(--text-secondary)",
                        borderRadius: "4px",
                      }}
                    >
                      {skill.category}
                    </span>
                  </div>

                  {/* Skill Name */}
                  <h3
                    style={{
                      fontFamily: '"Noto Sans", sans-serif',
                      fontSize: "18px",
                      fontWeight: 500,
                      lineHeight: 1.3,
                      marginBottom: "8px",
                      color: "var(--text-primary)",
                    }}
                  >
                    {skill.name}
                  </h3>

                  {/* Description */}
                  <p
                    style={{
                      fontFamily: '"Noto Sans", sans-serif',
                      fontSize: "14px",
                      fontWeight: 300,
                      lineHeight: 1.6,
                      color: "var(--text-secondary)",
                      marginBottom: "16px",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {skill.description}
                  </p>

                  {/* View Docs Link */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontFamily: '"Noto Sans", sans-serif',
                      fontSize: "14px",
                      fontWeight: 500,
                      color: "var(--primary)",
                    }}
                  >
                    <span>View documentation</span>
                    <svg
                      style={{ width: "14px", height: "14px" }}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta-final">
        <div className="container">
          <div className="cta-card">
            <div className="cta-ellipse"></div>
            <h2 className="cta-title">Can't find what you need?</h2>
            <p className="cta-subtitle">
              Request a new skill or contribute to our open-source collection
            </p>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <a
                href="https://github.com/vm0-ai/vm0-skills/issues/new"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary-large"
              >
                Request a Skill
              </a>
              <a
                href="https://github.com/vm0-ai/vm0-skills"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary-large"
              >
                Contribute on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      <Footer />

      <style jsx>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        .skill-card:hover {
          border-color: var(--primary);
          transform: translateY(-2px);
        }
        @media (min-width: 768px) {
          section
            .container
            > div
            > div:has(input[type="text"])
            + select {
            flex-direction: row;
          }
        }
      `}</style>
    </>
  );
}
