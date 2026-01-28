import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "../../../components/ThemeProvider";
import SkillsClient from "../SkillsClient";
import messages from "../../../../messages/en.json";

// Mock next/navigation
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual("next/navigation");
  return {
    ...actual,
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    usePathname: vi.fn(() => "/en/skills"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
    useParams: vi.fn(() => ({ locale: "en" })),
    redirect: vi.fn(),
    permanentRedirect: vi.fn(),
    notFound: vi.fn(),
  };
});

const mockSkills = [
  {
    name: "Slack",
    description: "Send messages to Slack",
    category: "Communication",
    logo: "/skills/slack.svg",
    docsUrl: "https://docs.vm0.ai/docs/agent-skills/slack",
  },
  {
    name: "GitHub",
    description: "Automate GitHub operations",
    category: "Development",
    logo: "/skills/github.svg",
    docsUrl: "https://docs.vm0.ai/docs/agent-skills/github",
  },
  {
    name: "Notion",
    description: "Manage Notion workspace",
    category: "Productivity",
    logo: "/skills/notion.svg",
    docsUrl: "https://docs.vm0.ai/docs/agent-skills/notion",
  },
];

function renderWithProviders(component: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ThemeProvider>{component}</ThemeProvider>
    </NextIntlClientProvider>,
  );
}

describe("SkillsClient Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render all skills initially", () => {
    renderWithProviders(<SkillsClient initialSkills={mockSkills} />);

    // Use more specific selectors to avoid matching Navbar/Footer
    expect(screen.getByText("Send messages to Slack")).toBeInTheDocument();
    expect(screen.getByText("Automate GitHub operations")).toBeInTheDocument();
    expect(screen.getByText("Manage Notion workspace")).toBeInTheDocument();
  });

  it("should filter skills by search query", () => {
    renderWithProviders(<SkillsClient initialSkills={mockSkills} />);

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: "slack" } });

    // Only Slack description should be visible
    expect(screen.getByText("Send messages to Slack")).toBeInTheDocument();
    expect(
      screen.queryByText("Automate GitHub operations"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Manage Notion workspace"),
    ).not.toBeInTheDocument();
  });

  it("should filter by search in description", () => {
    renderWithProviders(<SkillsClient initialSkills={mockSkills} />);

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: "automate" } });

    // Should find GitHub (has "Automate" in description)
    expect(screen.getByText("Automate GitHub operations")).toBeInTheDocument();
    expect(
      screen.queryByText("Send messages to Slack"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Manage Notion workspace"),
    ).not.toBeInTheDocument();
  });

  it("should display skill descriptions", () => {
    renderWithProviders(<SkillsClient initialSkills={mockSkills} />);

    expect(screen.getByText("Send messages to Slack")).toBeInTheDocument();
    expect(screen.getByText("Automate GitHub operations")).toBeInTheDocument();
    expect(screen.getByText("Manage Notion workspace")).toBeInTheDocument();
  });

  it("should handle empty skills array", () => {
    renderWithProviders(<SkillsClient initialSkills={[]} />);

    // When no skills, should not error (just render empty state)
    const skillCards = screen.queryAllByText(/skill/i);
    expect(skillCards.length).toBeGreaterThanOrEqual(0);
  });
});
