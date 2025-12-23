"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("skills");
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
            <h1 className="hero-title">{t("hero.title")}</h1>
            <p className="hero-description">{t("hero.description")}</p>
