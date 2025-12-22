"use client";

import { useState } from "react";
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

interface SkillsClientProps {
  initialSkills: SkillMetadata[];
}

export default function SkillsClient({ initialSkills }: SkillsClientProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  // Group skills by category
  const skillsByCategory = initialSkills.reduce(
    (acc, skill) => {
      if (!acc[skill.category]) {
        acc[skill.category] = [];
      }
      acc[skill.category]!.push(skill);
      return acc;
    },
    {} as Record<string, SkillMetadata[]>,
  );

  const skillsData = {
    success: true,
    total: initialSkills.length,
    categories: Object.keys(skillsByCategory).length,
    skillsByCategory,
    skills: initialSkills,
  };

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
            <h1 className="hero-title">VM0 Agent Skills</h1>
            <p className="hero-description">
              Pre-built integrations for AI agents. Connect to popular services
              with zero configuration.
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
                <span>{skillsData.total} Skills</span>
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
                <span>{skillsData.categories} Categories</span>
              </div>
            </div>

            {/* Search and Filter */}
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
                    placeholder="Search skills..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="skills-search-input"
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
                    className="skills-category-select"
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
                        {category === "all" ? "All Categories" : category}
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
                gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
                gap: "24px",
              }}
            >
              {filteredSkills.map((skill) => (
                <div
                  key={skill.name}
                  className="skill-card"
                  style={{
                    background: "var(--card-bg)",
                    border: "1px solid var(--border-light)",
                    borderRadius: "16px",
                    padding: "24px",
                    transition: "all 0.3s ease",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {/* Logo */}
                  <div style={{ marginBottom: "16px" }}>
                    <div
                      style={{
                        width: "40px",
                        height: "40px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {skill.logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={skill.logo}
                          alt={skill.name}
                          width="32"
                          height="32"
                          style={{
                            objectFit: "contain",
                            maxWidth: "32px",
                            maxHeight: "32px",
                          }}
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                            const parent = e.currentTarget.parentElement;
                            if (parent) {
                              parent.innerHTML = `
                                <svg
                                  style="width: 28px; height: 28px; color: var(--text-muted)"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  stroke-width="1.5"
                                  viewBox="0 0 24 24"
                                >
                                  <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                                </svg>
                              `;
                            }
                          }}
                        />
                      ) : (
                        <svg
                          style={{
                            width: "28px",
                            height: "28px",
                            color: "var(--text-muted)",
                          }}
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.5"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                        </svg>
                      )}
                    </div>
                  </div>

                  {/* Category Badge */}
                  <div style={{ marginBottom: "8px" }}>
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
                      {skill.category}
                    </span>
                  </div>

                  {/* Skill Name */}
                  <h3
                    style={{
                      fontFamily: '"Noto Sans", sans-serif',
                      fontSize: "20px",
                      fontWeight: 600,
                      marginBottom: "8px",
                      color: "var(--text-primary)",
                      textTransform: "capitalize",
                    }}
                  >
                    {skill.name}
                  </h3>

                  {/* Description */}
                  <p
                    style={{
                      fontFamily: '"Fira Mono", monospace',
                      fontSize: "14px",
                      color: "var(--text-secondary)",
                      lineHeight: 1.5,
                      marginBottom: "16px",
                      flex: 1,
                    }}
                  >
                    {skill.description}
                  </p>

                  {/* View Docs Link */}
                  <div
                    style={{
                      paddingTop: "16px",
                      borderTop: "1px solid var(--border-light)",
                      marginTop: "auto",
                    }}
                  >
                    <a
                      href={skill.docsUrl || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        color: "var(--primary)",
                        textDecoration: "none",
                        fontFamily: '"Fira Mono", monospace',
                        fontSize: "14px",
                        fontWeight: 500,
                      }}
                    >
                      View documentation
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                    </a>
                  </div>
                </div>
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
            <h2 className="cta-title">Can&apos;t find what you need?</h2>
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

      {/* eslint-disable-next-line react/no-unknown-property */}
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
        .skills-search-input:focus {
          outline: none;
          border-color: rgba(255, 255, 255, 0.2);
        }
        .skills-category-select:focus {
          outline: none;
          border-color: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </>
  );
}
