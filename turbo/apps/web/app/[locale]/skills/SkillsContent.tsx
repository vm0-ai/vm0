'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import './skills.css';

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

export default function SkillsContent() {
  const [skillsData, setSkillsData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  useEffect(() => {
    fetchSkills();
  }, []);

  async function fetchSkills() {
    try {
      const response = await fetch('/api/skills');
      const data = await response.json();
      setSkillsData(data);
    } catch (error) {
      console.error('Failed to fetch skills:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="skills-loading">
        <div className="skills-loading-content">
          <div className="skills-spinner"></div>
          <p className="skills-loading-text">Loading skills...</p>
        </div>
      </div>
    );
  }

  if (!skillsData || !skillsData.success) {
    return (
      <div className="skills-loading">
        <div className="skills-loading-content">
          <p className="skills-loading-text">Failed to load skills</p>
          <button onClick={fetchSkills} className="skills-retry-button">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const categories = ['all', ...Object.keys(skillsData.skillsByCategory).sort()];

  const filteredSkills = skillsData.skills.filter(skill => {
    const matchesSearch =
      skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory =
      selectedCategory === 'all' || skill.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="skills-page">
      {/* Hero Section */}
      <section className="skills-hero">
        <div className="skills-hero-bg">
          <div className="skills-hero-gradient"></div>
        </div>

        <div className="skills-hero-content">
          <div className="skills-hero-text">
            <h1 className="skills-title">VM0 Skills</h1>
            <p className="skills-description">
              Pre-built integrations for AI agents. Connect to 50+ services with zero configuration.
            </p>
            <div className="skills-stats">
              <div className="skills-stat">
                <div className="skills-stat-dot"></div>
                <span>{skillsData.total} Skills</span>
              </div>
              <div className="skills-stat">
                <div className="skills-stat-dot"></div>
                <span>{skillsData.categories} Categories</span>
              </div>
            </div>
          </div>

          {/* Search and Filter */}
          <div className="skills-search-wrapper">
            <div className="skills-search-container">
              <div className="skills-search-input-wrapper">
                <input
                  type="text"
                  placeholder="Search skills..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="skills-search-input"
                />
                <svg
                  className="skills-search-icon"
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
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="skills-filter-select"
              >
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category === 'all' ? 'All Categories' : category}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Results Count */}
          <div className="skills-results-count">
            <p>
              {filteredSkills.length === skillsData.total
                ? `Showing all ${filteredSkills.length} skills`
                : `Found ${filteredSkills.length} skills`}
            </p>
          </div>

          {/* Skills Grid */}
          {filteredSkills.length === 0 ? (
            <div className="skills-empty">
              <p>No skills found matching your criteria</p>
            </div>
          ) : (
            <div className="skills-grid">
              {filteredSkills.map((skill) => (
                <Link
                  key={skill.name}
                  href={skill.docsUrl || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="skill-card"
                >
                  {/* Logo and Category */}
                  <div className="skill-card-header">
                    <div className="skill-logo">
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
                          className="skill-logo-fallback"
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
                    <span className="skill-category">{skill.category}</span>
                  </div>

                  {/* Skill Name */}
                  <h3 className="skill-name">{skill.name}</h3>

                  {/* Description */}
                  <p className="skill-description">{skill.description}</p>

                  {/* View Docs Link */}
                  <div className="skill-link">
                    <span>View documentation</span>
                    <svg
                      className="skill-link-arrow"
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
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* CTA Section */}
      <section className="skills-cta">
        <div className="skills-cta-content">
          <h2 className="skills-cta-title">Can't find what you need?</h2>
          <p className="skills-cta-description">
            Request a new skill or contribute to our open-source collection
          </p>
          <div className="skills-cta-buttons">
            <Link
              href="https://github.com/vm0-ai/vm0-skills/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="skills-cta-button-primary"
            >
              Request a Skill
            </Link>
            <Link
              href="https://github.com/vm0-ai/vm0-skills"
              target="_blank"
              rel="noopener noreferrer"
              className="skills-cta-button-secondary"
            >
              Contribute on GitHub
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
