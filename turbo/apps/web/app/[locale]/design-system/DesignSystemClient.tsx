"use client";

import { useState } from "react";
import { useTheme } from "../../components/ThemeProvider";
import { Button } from "@vm0/ui/components/ui/button";
import { Card, CardContent } from "@vm0/ui/components/ui/card";
import { Input } from "@vm0/ui/components/ui/input";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { Checkbox } from "@vm0/ui/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
} from "@vm0/ui/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui/components/ui/table";
import {
  IconCheck,
  IconX,
  IconCopy,
  IconBrandGithub,
  IconSearch,
  IconSettings,
  IconTrash,
  IconInfoCircle,
  IconMoon,
  IconSun,
  IconCalendar,
  IconUser,
  IconMail,
  IconPhone,
  IconChevronRight,
} from "@tabler/icons-react";

type Section =
  | "overview"
  | "colors"
  | "typography"
  | "tokens"
  | "components-button"
  | "components-input"
  | "components-card"
  | "components-dialog"
  | "components-tooltip"
  | "components-checkbox"
  | "components-select"
  | "components-popover"
  | "components-table"
  | "components-copy-button"
  | "components-icons";

// eslint-disable-next-line complexity
export default function DesignSystemClient() {
  const [activeSection, setActiveSection] = useState<Section>("overview");
  const [componentsExpanded, setComponentsExpanded] = useState(true);
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-divider bg-background/95 backdrop-blur">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <svg
              width="100"
              height="30"
              viewBox="0 0 100 30"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M13.3915 0.0627979C13.2455 -0.0209506 13.0657 -0.020839 12.9198 0.0630906L1.0053 6.91543C0.692394 7.09539 0.690093 7.54442 1.00114 7.72755L12.9156 14.7423C13.0636 14.8295 13.2475 14.8296 13.3957 14.7426L25.3445 7.72785C25.6562 7.54485 25.6539 7.09497 25.3404 6.91514L13.3915 0.0627979Z"
                fill="#ED4E01"
              />
              <path
                d="M0.710495 8.33374L12.6479 15.2595C12.7944 15.3445 12.8846 15.5015 12.8846 15.6715L12.8843 29.5237C12.8843 29.8899 12.4897 30.1187 12.1741 29.9356L0.236691 23.0096C0.0902206 22.9246 -3.46036e-06 22.7676 0 22.5977L0.00028208 8.74568C0.000289537 8.37949 0.394855 8.15064 0.710495 8.33374Z"
                fill="#ED4E01"
              />
              <path
                d="M24.947 21.6772C24.947 21.9507 24.8017 22.2036 24.5655 22.3415L16.2103 27.219C15.6975 27.5184 15.0533 27.1485 15.0533 26.5547L15.0531 16.7842C15.0531 16.5107 15.1983 16.2578 15.4345 16.1199L23.7897 11.2425C24.3025 10.9431 24.9468 11.313 24.9468 11.9068L24.947 21.6772ZM13.6541 16.3426V29.5279C13.6541 29.8852 14.0308 30.1106 14.3391 29.9444L14.3538 29.9362L25.5769 23.3654C26.25 22.9808 26.3462 22.6924 26.3459 22.1188L26.3459 8.93378C26.3459 8.57084 25.9572 8.344 25.6462 8.52548L14.4231 15.0001C14.0385 15.2885 13.6539 15.577 13.6541 16.3426Z"
                fill="#ED4E01"
              />
              <path
                d="M25.9616 10.58L15.2113 28.4616L14.2308 27.8817L24.981 10.0001L25.9616 10.58Z"
                fill="#ED4E01"
              />
              <path
                d="M42.1865 25L34.3459 5H37.4651L43.7887 21.4575L50.1264 5H53.2315L45.3908 25H42.1865Z"
                fill="currentColor"
              />
              <path
                d="M66.9877 25L59.4023 10.3417V25H56.4957V5H59.6716L67.413 20.0628L75.1686 5H78.3304V25H75.438V10.3417L67.8526 25H66.9877Z"
                fill="currentColor"
              />
              <path
                d="M99.3459 22.1409C99.3459 22.5314 99.2703 22.9033 99.1191 23.2566C98.9678 23.6007 98.7599 23.9028 98.4952 24.1632C98.2305 24.4235 97.9186 24.6281 97.5594 24.7768C97.2097 24.9256 96.8363 25 96.4393 25H86.2735C85.8765 25 85.4984 24.9256 85.1392 24.7768C84.7894 24.6281 84.4822 24.4235 84.2176 24.1632C83.9529 23.9028 83.745 23.6007 83.5937 23.2566C83.4425 22.9033 83.3669 22.5314 83.3669 22.1409V7.85914C83.3669 7.46862 83.4425 7.10135 83.5937 6.75732C83.745 6.404 83.9529 6.10181 84.2176 5.85077C84.4822 5.59042 84.7894 5.38587 85.1392 5.2371C85.4984 5.07903 85.8765 5 86.2735 5H96.4393C96.8363 5 97.2097 5.07903 97.5594 5.2371C97.9186 5.38587 98.2305 5.59042 98.4952 5.85077C98.7599 6.10181 98.9678 6.404 99.1191 6.75732C99.2703 7.10135 99.3459 7.46862 99.3459 7.85914V22.1409ZM86.2735 7.85914V22.1409H96.4393V7.85914H86.2735Z"
                fill="currentColor"
              />
              <path
                d="M94.8994 6.79107L97.1494 8.06891L87.8973 23.8325L85.6473 22.5547L94.8994 6.79107Z"
                fill="currentColor"
              />
            </svg>
            <span className="text-sm text-muted-foreground">Design System</span>
          </div>
          <div className="flex items-center gap-3">
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleTheme}
                    aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                  >
                    {theme === "dark" ? (
                      <IconSun className="h-5 w-5" />
                    ) : (
                      <IconMoon className="h-5 w-5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    {theme === "dark"
                      ? "Switch to light mode"
                      : "Switch to dark mode"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span className="text-sm text-muted-foreground">v1.0</span>
          </div>
        </div>
      </header>

      <div className="container mx-auto flex gap-8 px-4 pb-8 pt-24">
        {/* Sidebar Navigation */}
        <aside className="sticky top-24 h-fit w-64 shrink-0">
          <nav className="space-y-1">
            <NavItem
              active={activeSection === "overview"}
              onClick={() => setActiveSection("overview")}
            >
              Overview
            </NavItem>
            <NavItem
              active={activeSection === "colors"}
              onClick={() => setActiveSection("colors")}
            >
              Colors
            </NavItem>
            <NavItem
              active={activeSection === "typography"}
              onClick={() => setActiveSection("typography")}
            >
              Typography
            </NavItem>

            {/* Components Section with Submenu */}
            <div>
              <button
                onClick={() => setComponentsExpanded(!componentsExpanded)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-muted ${
                  activeSection.startsWith("components-")
                    ? "text-primary"
                    : "text-foreground"
                }`}
              >
                Components
                <IconChevronRight
                  className={`h-4 w-4 transition-transform ${componentsExpanded ? "rotate-90" : ""}`}
                />
              </button>
              {componentsExpanded && (
                <div className="ml-3 mt-1 space-y-1 border-l border-divider pl-3">
                  <SubNavItem
                    active={activeSection === "components-button"}
                    onClick={() => setActiveSection("components-button")}
                  >
                    Button
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-input"}
                    onClick={() => setActiveSection("components-input")}
                  >
                    Input
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-dialog"}
                    onClick={() => setActiveSection("components-dialog")}
                  >
                    Dialog
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-tooltip"}
                    onClick={() => setActiveSection("components-tooltip")}
                  >
                    Tooltip
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-checkbox"}
                    onClick={() => setActiveSection("components-checkbox")}
                  >
                    Checkbox
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-select"}
                    onClick={() => setActiveSection("components-select")}
                  >
                    Select
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-popover"}
                    onClick={() => setActiveSection("components-popover")}
                  >
                    Popover
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-table"}
                    onClick={() => setActiveSection("components-table")}
                  >
                    Table
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-copy-button"}
                    onClick={() => setActiveSection("components-copy-button")}
                  >
                    Copy Button
                  </SubNavItem>
                  <SubNavItem
                    active={activeSection === "components-icons"}
                    onClick={() => setActiveSection("components-icons")}
                  >
                    Icons
                  </SubNavItem>
                </div>
              )}
            </div>

            <NavItem
              active={activeSection === "tokens"}
              onClick={() => setActiveSection("tokens")}
            >
              Design Tokens
            </NavItem>
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 space-y-12 pb-32 [&_section>div:first-child]:pt-8">
          {activeSection === "overview" && <OverviewSection />}
          {activeSection === "colors" && <ColorsSection />}
          {activeSection === "typography" && <TypographySection />}
          {activeSection === "tokens" && <TokensSection />}

          {/* Component Pages */}
          {activeSection === "components-button" && <ButtonComponentPage />}
          {activeSection === "components-input" && <InputComponentPage />}
          {activeSection === "components-dialog" && <DialogComponentPage />}
          {activeSection === "components-tooltip" && <TooltipComponentPage />}
          {activeSection === "components-checkbox" && <CheckboxComponentPage />}
          {activeSection === "components-select" && <SelectComponentPage />}
          {activeSection === "components-popover" && <PopoverComponentPage />}
          {activeSection === "components-table" && <TableComponentPage />}
          {activeSection === "components-copy-button" && (
            <CopyButtonComponentPage />
          )}
          {activeSection === "components-icons" && <IconsComponentPage />}
        </main>
      </div>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

function OverviewSection() {
  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold">Overview</h2>
        <p className="mt-2 text-muted-foreground">
          A systematic approach to building consistent, accessible interfaces
        </p>
      </div>

      <div className="prose prose-gray max-w-none">
        <h3 className="text-xl font-semibold text-foreground">
          Design principles
        </h3>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          The VM0 design system enables anyone to quickly build interfaces that
          align with our design language, even without prior knowledge of
          VM0&apos;s visual style. By providing ready-to-use components, tokens,
          and patterns, developers can rapidly prototype demos and implement
          production features with built-in consistency. This systematic
          approach ensures that every interface whether built by core team
          members or new contributors maintains the same level of quality,{" "}
          <strong>consistency</strong>, <strong>scalability</strong>, and{" "}
          <strong>maintainability</strong>.
        </p>

        <h3 className="mt-8 text-xl font-semibold text-foreground">
          Architecture
        </h3>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          Our design system follows a three-layer token architecture, from
          atomic values to high-level utilities:
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="space-y-6">
            <div>
              <h4 className="font-semibold text-foreground mb-2">
                Base color tokens
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Foundational color scales (primary-0 through primary-950, gray-0
                through gray-950) that define the atomic values of our design
                language. These HSL values adapt automatically between light and
                dark themes.
              </p>
            </div>

            <div>
              <h4 className="font-semibold text-foreground mb-2">
                Semantic tokens
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Purpose-driven tokens (background, foreground, border, card,
                muted, accent) that map to base colors. Use these for component
                styling to ensure consistency and proper theme support.
              </p>
            </div>

            <div>
              <h4 className="font-semibold text-foreground mb-2">
                Tailwind Utilities
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                High-level utility classes (bg-primary, text-sm, rounded-lg)
                built on top of semantic tokens. These provide the final API for
                rapid component development.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="prose prose-gray max-w-none">
        <h3 className="mt-8 text-xl font-semibold text-foreground">
          Brand identity
        </h3>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          VM0&apos;s brand color is{" "}
          <strong className="font-mono text-primary">#ED4E01</strong>, a vibrant
          orange that represents energy, innovation, and warmth. This primary
          color anchors our entire color system and is complemented by a
          carefully crafted neutral palette that ensures excellent readability
          and visual hierarchy.
        </p>

        <h3 className="mt-8 text-xl font-semibold text-foreground">
          Theme support
        </h3>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          All components and tokens are designed to work seamlessly in both
          light and dark modes. The design system automatically adapts color
          values, ensuring optimal contrast and readability in any environment.
        </p>
      </div>
    </section>
  );
}

function ColorsSection() {
  const primaryColors = [
    { name: "primary-0", hsl: "16 100% 98%", hex: "#FFFBF7" },
    { name: "primary-50", hsl: "15 100% 96%", hex: "#FCF3F0" },
    { name: "primary-100", hsl: "14 100% 93%", hex: "#FDE7DF" },
    { name: "primary-200", hsl: "14 100% 89%", hex: "#FFD5C5" },
    { name: "primary-300", hsl: "14 100% 85%", hex: "#FFC5B0" },
    { name: "primary-400", hsl: "14 100% 81%", hex: "#FFB69E" },
    { name: "primary-500", hsl: "14 92% 74%", hex: "#F4A288" },
    { name: "primary-600", hsl: "15 80% 66%", hex: "#EB8868" },
    { name: "primary-700", hsl: "20 99% 47%", hex: "#ED4E01", brand: true },
    { name: "primary-800", hsl: "17 100% 44%", hex: "#DE3F00" },
    { name: "primary-900", hsl: "16 100% 41%", hex: "#D03200" },
    { name: "primary-950", hsl: "16 38% 23%", hex: "#5C2918" },
  ];

  const grayColors = [
    {
      name: "gray-0",
      hsl: "30 100% 99%",
      hex: "#FFFCF9",
      usage: "Page background",
    },
    { name: "gray-50", hsl: "28 38% 95%", hex: "#F9F4EF", usage: "Sidebar" },
    { name: "gray-100", hsl: "28 18% 92%", hex: "#F0EBE5" },
    { name: "gray-200", hsl: "28 18% 90%", hex: "#E8E2DD" },
    { name: "gray-300", hsl: "28 15% 87%", hex: "#E1DBD5", usage: "Border" },
    { name: "gray-400", hsl: "28 13% 84%", hex: "#D9D3CD" },
    { name: "gray-500", hsl: "28 12% 79%", hex: "#CEC8C2" },
    { name: "gray-600", hsl: "28 10% 71%", hex: "#BAB5AF" },
    { name: "gray-700", hsl: "20 6% 54%", hex: "#8C8782" },
    {
      name: "gray-800",
      hsl: "20 6% 49%",
      hex: "#827D77",
      usage: "Secondary text",
    },
    { name: "gray-900", hsl: "20 6% 38%", hex: "#635E59" },
    {
      name: "gray-950",
      hsl: "20 12% 12%",
      hex: "#231F1B",
      usage: "Primary text",
    },
  ];

  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold">Colors</h2>
        <p className="mt-2 text-muted-foreground">
          Complete color palette with HSL and Hex values
        </p>
      </div>

      {/* Primary Colors */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            Primary colors (brand orange)
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Main brand color scale with warm orange tones
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {primaryColors.map((color) => (
            <ColorCard key={color.name} {...color} />
          ))}
        </div>
      </div>

      {/* Gray Colors */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            Gray scale (neutral)
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Warm-toned neutral colors for backgrounds, text, and borders
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {grayColors.map((color) => (
            <ColorCard key={color.name} {...color} />
          ))}
        </div>
      </div>

      {/* Theme Comparison */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            Theme comparison
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            How colors adapt in light and dark modes
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-gray-0 p-4">
            <h4 className="mb-3 font-semibold">Light Mode</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md bg-white p-2 shadow-sm">
                <span className="text-sm">Background</span>
                <span className="font-mono text-xs">#FFFCF9</span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-gray-950 p-2 text-white">
                <span className="text-sm">Foreground</span>
                <span className="font-mono text-xs">#231F1B</span>
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-300 bg-gray-0 p-4 dark:border-gray-300 dark:bg-gray-0">
            <h4 className="mb-3 font-semibold text-gray-950">Dark Mode</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md bg-[#111113] p-2 text-white shadow-sm">
                <span className="text-sm">Background</span>
                <span className="font-mono text-xs">#111113</span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-[#EEEEF0] p-2 text-gray-950">
                <span className="text-sm">Foreground</span>
                <span className="font-mono text-xs">#EEEEF0</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ColorCard({
  name,
  hsl,
  hex,
  brand,
  usage,
}: {
  name: string;
  hsl: string;
  hex: string;
  brand?: boolean;
  usage?: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border">
      <div
        className="h-24 w-full transition-transform group-hover:scale-105"
        style={{ backgroundColor: hex }}
      />
      <div className="p-3">
        <div className="mb-1 flex items-center justify-between">
          <code className="text-xs font-semibold">{name}</code>
          {brand && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Brand
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted-foreground">{hex}</p>
          <CopyButton text={hex} />
        </div>
        <p className="font-mono text-xs text-muted-foreground">hsl({hsl})</p>
        {usage && <p className="mt-1 text-xs text-primary">{usage}</p>}
      </div>
    </div>
  );
}

function TypographySection() {
  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold">Typography</h2>
        <p className="mt-2 text-muted-foreground">
          Font families, sizes, and text styles
        </p>
      </div>

      {/* Font Families */}
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-foreground">Font families</h3>
        <div className="space-y-6">
          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">
              Sans serif (body)
            </p>
            <p
              className="text-2xl"
              style={{ fontFamily: "var(--font-family-sans)" }}
            >
              Noto Sans - The quick brown fox jumps over the lazy dog
            </p>
            <code className="mt-1 block text-xs text-muted-foreground">
              font-family: var(--font-family-sans)
            </code>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">
              Monospace (code)
            </p>
            <p className="font-mono text-2xl">
              JetBrains Mono - The quick brown fox jumps over the lazy dog
            </p>
            <code className="mt-1 block text-xs text-muted-foreground">
              font-family: var(--font-family-mono)
            </code>
          </div>
        </div>
      </div>

      {/* Font Sizes */}
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-foreground">Font sizes</h3>
        <div className="space-y-3">
          <div className="flex items-baseline gap-4">
            <code className="w-24 text-xs text-muted-foreground">text-2xl</code>
            <p className="text-2xl">24px - Large Heading</p>
          </div>
          <div className="flex items-baseline gap-4">
            <code className="w-24 text-xs text-muted-foreground">text-lg</code>
            <p className="text-lg">18px - Heading</p>
          </div>
          <div className="flex items-baseline gap-4">
            <code className="w-24 text-xs text-muted-foreground">
              text-base
            </code>
            <p className="text-base">16px - Base Text</p>
          </div>
          <div className="flex items-baseline gap-4">
            <code className="w-24 text-xs text-muted-foreground">text-sm</code>
            <p className="text-sm">14px - Body Text</p>
          </div>
          <div className="flex items-baseline gap-4">
            <code className="w-24 text-xs text-muted-foreground">text-xs</code>
            <p className="text-xs">12px - Small Text</p>
          </div>
        </div>
      </div>

      {/* Text Colors */}
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-foreground">Text colors</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <p className="text-foreground">Primary Text (foreground)</p>
            <code className="text-xs">text-foreground</code>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <p className="text-muted-foreground">
              Secondary Text (muted-foreground)
            </p>
            <code className="text-xs">text-muted-foreground</code>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <p className="text-primary">Primary Color Text</p>
            <code className="text-xs">text-primary</code>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <p className="text-destructive">Destructive Text</p>
            <code className="text-xs">text-destructive</code>
          </div>
        </div>
      </div>
    </section>
  );
}

function TokensSection() {
  // Category 1: Base Color Tokens
  const primaryColorTokens = [
    { name: "primary-0", light: "#FFFBF7", dark: "#160F0D" },
    { name: "primary-50", light: "#FCF3F0", dark: "#1F1512" },
    { name: "primary-100", light: "#FDE7DF", dark: "#38180D" },
    { name: "primary-200", light: "#FFD5C5", dark: "#4F1603" },
    { name: "primary-300", light: "#FFC5B0", dark: "#5E1E06" },
    { name: "primary-400", light: "#FFB69E", dark: "#6E2A13" },
    { name: "primary-500", light: "#F4A288", dark: "#873B22" },
    { name: "primary-600", light: "#EB8868", dark: "#AE4D2C" },
    { name: "primary-700", light: "#ED4E01", dark: "#ED4E01" },
    { name: "primary-800", light: "#DE3F00", dark: "#DE3F00" },
    { name: "primary-900", light: "#D03200", dark: "#FF946E" },
    { name: "primary-950", light: "#5C2918", dark: "#FED5C7" },
  ];

  const grayColorTokens = [
    { name: "gray-0", light: "#FFFCF9", dark: "#111113" },
    { name: "gray-50", light: "#F9F4EF", dark: "#19191B" },
    { name: "gray-100", light: "#F0EBE5", dark: "#222325" },
    { name: "gray-200", light: "#E8E2DD", dark: "#292A2E" },
    { name: "gray-300", light: "#E1DBD5", dark: "#303136" },
    { name: "gray-400", light: "#D9D3CD", dark: "#393A40" },
    { name: "gray-500", light: "#CEC8C2", dark: "#46484F" },
    { name: "gray-600", light: "#BAB5AF", dark: "#5F606A" },
    { name: "gray-700", light: "#8C8782", dark: "#6C6E79" },
    { name: "gray-800", light: "#827D77", dark: "#797B86" },
    { name: "gray-900", light: "#635E59", dark: "#B2B3BD" },
    { name: "gray-950", light: "#231F1B", dark: "#EEEEF0" },
  ];

  // Theme-aware colors (inverted in dark mode)
  const themeAwareTokens = [
    {
      name: "white",
      light: "#FFFFFF",
      dark: "#19191B",
      description: "Pure white (inverted to dark gray in dark mode)",
    },
    {
      name: "black",
      light: "#19191B",
      dark: "#FFFFFF",
      description: "Dark gray (inverted to white in dark mode)",
    },
    {
      name: "divider",
      light: "hsl(20, 35%, 88%)",
      dark: "hsl(240, 3%, 19%)",
      description: "Divider lines with warm orange tint",
    },
  ];

  // Category 2: Semantic Tokens
  const semanticTokens = [
    { name: "background", maps: "gray-0", usage: "Page background" },
    { name: "foreground", maps: "gray-950", usage: "Primary text color" },
    { name: "card", maps: "white", usage: "Card background" },
    { name: "card-foreground", maps: "gray-950", usage: "Card text color" },
    {
      name: "primary",
      maps: "primary-700",
      usage: "Primary brand color, buttons",
    },
    {
      name: "primary-foreground",
      maps: "on-filled",
      usage: "Text on primary background",
    },
    { name: "secondary", maps: "gray-100", usage: "Secondary backgrounds" },
    {
      name: "secondary-foreground",
      maps: "gray-950",
      usage: "Text on secondary background",
    },
    { name: "muted", maps: "gray-100", usage: "Muted backgrounds" },
    { name: "muted-foreground", maps: "gray-800", usage: "Muted text, labels" },
    { name: "accent", maps: "primary-100", usage: "Accent/hover backgrounds" },
    {
      name: "accent-foreground",
      maps: "gray-950",
      usage: "Text on accent background",
    },
    {
      name: "destructive",
      maps: "red-600",
      usage: "Destructive actions, errors",
    },
    {
      name: "destructive-foreground",
      maps: "on-filled",
      usage: "Text on destructive background",
    },
    { name: "border", maps: "gray-300", usage: "Border color" },
    { name: "input", maps: "white", usage: "Input field background" },
    { name: "ring", maps: "primary-600", usage: "Focus ring color" },
    { name: "on-filled", maps: "white", usage: "Text on colored backgrounds" },
    { name: "background-50", maps: "gray-50", usage: "Code block background" },
  ];

  // Category 3: Tailwind Basic Utility Tokens
  const tailwindUtilities = [
    {
      category: "Text Size",
      tokens: [
        { name: "text-xs", value: "12px", usage: "Extra small text" },
        { name: "text-sm", value: "14px", usage: "Small text, labels" },
        { name: "text-base", value: "16px", usage: "Base body text" },
        { name: "text-lg", value: "18px", usage: "Large text, subtitles" },
        { name: "text-xl", value: "20px", usage: "Extra large text" },
        { name: "text-2xl", value: "24px", usage: "Heading text" },
      ],
    },
    {
      category: "Font Weight",
      tokens: [
        { name: "font-normal", value: "400", usage: "Normal weight" },
        { name: "font-medium", value: "500", usage: "Medium weight, emphasis" },
        { name: "font-semibold", value: "600", usage: "Semibold, headings" },
        { name: "font-bold", value: "700", usage: "Bold, strong emphasis" },
      ],
    },
    {
      category: "Border Radius",
      tokens: [
        { name: "rounded-none", value: "0px", usage: "No rounding" },
        { name: "rounded-sm", value: "4px", usage: "Small radius" },
        { name: "rounded", value: "4px", usage: "Default radius" },
        { name: "rounded-md", value: "6px", usage: "Medium radius" },
        { name: "rounded-lg", value: "8px", usage: "Large radius" },
        { name: "rounded-xl", value: "12px", usage: "Extra large radius" },
        { name: "rounded-2xl", value: "16px", usage: "Double XL radius" },
        {
          name: "rounded-full",
          value: "9999px",
          usage: "Fully rounded, circular",
        },
      ],
    },
    {
      category: "Spacing (Padding)",
      tokens: [
        { name: "p-0", value: "0px", usage: "No padding" },
        { name: "p-1", value: "4px", usage: "Extra small padding" },
        { name: "p-2", value: "8px", usage: "Small padding" },
        { name: "p-3", value: "12px", usage: "Medium padding" },
        { name: "p-4", value: "16px", usage: "Base padding" },
        { name: "p-6", value: "24px", usage: "Large padding" },
        { name: "p-8", value: "32px", usage: "Extra large padding" },
        { name: "px-2", value: "8px horizontal", usage: "Horizontal padding" },
        { name: "px-3", value: "12px horizontal", usage: "Horizontal padding" },
        { name: "px-4", value: "16px horizontal", usage: "Horizontal padding" },
        { name: "py-1", value: "4px vertical", usage: "Vertical padding" },
        { name: "py-2", value: "8px vertical", usage: "Vertical padding" },
        { name: "py-4", value: "16px vertical", usage: "Vertical padding" },
      ],
    },
    {
      category: "Spacing (Margin)",
      tokens: [
        { name: "m-0", value: "0px", usage: "No margin" },
        { name: "m-1", value: "4px", usage: "Extra small margin" },
        { name: "m-2", value: "8px", usage: "Small margin" },
        { name: "m-4", value: "16px", usage: "Base margin" },
        {
          name: "mx-auto",
          value: "auto horizontal",
          usage: "Center horizontally",
        },
        { name: "mt-2", value: "8px top", usage: "Top margin" },
        { name: "mb-4", value: "16px bottom", usage: "Bottom margin" },
        { name: "ml-2", value: "8px left", usage: "Left margin" },
        { name: "mr-2", value: "8px right", usage: "Right margin" },
      ],
    },
    {
      category: "Size (Width)",
      tokens: [
        { name: "w-full", value: "100%", usage: "Full width" },
        { name: "w-auto", value: "auto", usage: "Auto width" },
        { name: "w-1/2", value: "50%", usage: "Half width" },
        { name: "w-1/3", value: "33.33%", usage: "One third width" },
        { name: "w-1/4", value: "25%", usage: "Quarter width" },
        { name: "w-64", value: "256px", usage: "Fixed 256px width" },
        { name: "w-72", value: "288px", usage: "Fixed 288px width" },
        { name: "w-80", value: "320px", usage: "Fixed 320px width" },
      ],
    },
    {
      category: "Size (Height)",
      tokens: [
        { name: "h-4", value: "16px", usage: "Icon height" },
        { name: "h-8", value: "32px", usage: "Small element" },
        { name: "h-9", value: "36px", usage: "Small button" },
        { name: "h-10", value: "40px", usage: "Default button/input" },
        { name: "h-11", value: "44px", usage: "Large button" },
        { name: "h-12", value: "48px", usage: "Extra large element" },
        { name: "h-full", value: "100%", usage: "Full height" },
        { name: "h-screen", value: "100vh", usage: "Full viewport height" },
      ],
    },
    {
      category: "Display",
      tokens: [
        { name: "block", value: "display: block", usage: "Block element" },
        {
          name: "inline-block",
          value: "display: inline-block",
          usage: "Inline block",
        },
        { name: "inline", value: "display: inline", usage: "Inline element" },
        { name: "flex", value: "display: flex", usage: "Flex container" },
        {
          name: "inline-flex",
          value: "display: inline-flex",
          usage: "Inline flex",
        },
        { name: "grid", value: "display: grid", usage: "Grid container" },
        { name: "hidden", value: "display: none", usage: "Hide element" },
      ],
    },
    {
      category: "Flexbox",
      tokens: [
        {
          name: "flex-row",
          value: "flex-direction: row",
          usage: "Horizontal layout",
        },
        {
          name: "flex-col",
          value: "flex-direction: column",
          usage: "Vertical layout",
        },
        {
          name: "items-start",
          value: "align-items: start",
          usage: "Align to start",
        },
        {
          name: "items-center",
          value: "align-items: center",
          usage: "Center align",
        },
        { name: "items-end", value: "align-items: end", usage: "Align to end" },
        {
          name: "justify-start",
          value: "justify-content: start",
          usage: "Justify to start",
        },
        {
          name: "justify-center",
          value: "justify-content: center",
          usage: "Center justify",
        },
        {
          name: "justify-between",
          value: "justify-content: between",
          usage: "Space between",
        },
        { name: "gap-2", value: "8px gap", usage: "Small gap" },
        { name: "gap-4", value: "16px gap", usage: "Base gap" },
      ],
    },
  ];

  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold">Design tokens</h2>
        <p className="mt-2 text-muted-foreground">
          Complete reference of all design tokens in the VM0 design system
        </p>
      </div>

      {/* Category 1: Base Color Tokens */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            1. Base color tokens
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Foundational color scales defined in globals.css. These are atomic
            HSL values that adapt to light/dark themes.
          </p>
        </div>
        <div className="space-y-6">
          {/* Primary Colors */}
          <div>
            <h4 className="mb-3 text-sm font-semibold text-foreground">
              Primary color scale (orange)
            </h4>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {primaryColorTokens.map((token) => (
                <div key={token.name} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="relative group/color">
                      <div
                        className="h-10 w-10 rounded-md border border-border cursor-pointer"
                        style={{ backgroundColor: token.light }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/color:opacity-100 transition-opacity">
                        <CopyButton text={token.light} />
                      </div>
                    </div>
                    <div className="relative group/color">
                      <div
                        className="h-10 w-10 rounded-md border border-border cursor-pointer"
                        style={{ backgroundColor: token.dark }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/color:opacity-100 transition-opacity">
                        <CopyButton text={token.dark} />
                      </div>
                    </div>
                  </div>
                  <code className="rounded bg-primary-50 px-1.5 py-0.5 text-xs text-primary-700 border border-primary-200">
                    {token.name}
                  </code>
                </div>
              ))}
            </div>
          </div>

          {/* Gray Colors */}
          <div>
            <h4 className="mb-3 text-sm font-semibold text-foreground">
              Gray color scale (neutral)
            </h4>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {grayColorTokens.map((token) => (
                <div key={token.name} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="relative group/color">
                      <div
                        className="h-10 w-10 rounded-md border border-border cursor-pointer"
                        style={{ backgroundColor: token.light }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/color:opacity-100 transition-opacity">
                        <CopyButton text={token.light} />
                      </div>
                    </div>
                    <div className="relative group/color">
                      <div
                        className="h-10 w-10 rounded-md border border-border cursor-pointer"
                        style={{ backgroundColor: token.dark }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/color:opacity-100 transition-opacity">
                        <CopyButton text={token.dark} />
                      </div>
                    </div>
                  </div>
                  <code className="rounded bg-primary-50 px-1.5 py-0.5 text-xs text-primary-700 border border-primary-200">
                    {token.name}
                  </code>
                </div>
              ))}
            </div>
          </div>

          {/* Theme-aware Colors */}
          <div>
            <h4 className="mb-3 text-sm font-semibold text-foreground">
              Theme-aware colors
            </h4>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {themeAwareTokens.map((token) => (
                <div key={token.name} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="relative group/color">
                      <div
                        className="h-10 w-10 rounded-md border border-border cursor-pointer"
                        style={{ backgroundColor: token.light }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/color:opacity-100 transition-opacity">
                        <CopyButton text={token.light} />
                      </div>
                    </div>
                    <div className="relative group/color">
                      <div
                        className="h-10 w-10 rounded-md border border-border cursor-pointer"
                        style={{ backgroundColor: token.dark }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/color:opacity-100 transition-opacity">
                        <CopyButton text={token.dark} />
                      </div>
                    </div>
                  </div>
                  <code className="rounded bg-primary-50 px-1.5 py-0.5 text-xs text-primary-700 border border-primary-200">
                    {token.name}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Category 2: Semantic Tokens */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            2. Semantic tokens
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Purpose-driven tokens that map to base colors. Use these for
            component styling to ensure consistency and theme support.
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Maps To</TableHead>
              <TableHead>Usage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {semanticTokens.map((token) => (
              <TableRow key={token.name}>
                <TableCell>
                  <code className="rounded bg-primary-50 px-2 py-0.5 text-xs text-primary-700 border border-primary-200">
                    {token.name}
                  </code>
                </TableCell>
                <TableCell>
                  <code className="rounded bg-muted px-2 py-0.5 text-xs">
                    {token.maps}
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {token.usage}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Category 3: Tailwind Utility Tokens */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            3. Tailwind basic utility tokens
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Common Tailwind utility classes for rapid component development
          </p>
        </div>
        <div className="space-y-6">
          {tailwindUtilities.map((category) => (
            <div key={category.category}>
              <h4 className="mb-3 text-sm font-semibold text-foreground">
                {category.category}
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Token</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Usage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {category.tokens.map((token) => (
                    <TableRow key={token.name}>
                      <TableCell>
                        <code className="rounded bg-muted px-2 py-0.5 text-xs text-foreground">
                          {token.name}
                        </code>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {token.value}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {token.usage}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// SubNavItem Component for nested navigation
function SubNavItem({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// Button Component Page
function ButtonComponentPage() {
  return (
    <TooltipProvider delayDuration={100}>
      <section className="space-y-12">
        {/* Header */}
        <div className="space-y-3">
          <h2 className="text-4xl font-bold tracking-tight">Button</h2>
          <p className="text-lg text-muted-foreground max-w-3xl">
            Trigger actions and events with customizable button variants. Built
            with accessibility and flexibility in mind.
          </p>
        </div>

        {/* Preview Section */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
            <p className="text-sm text-muted-foreground">
              Try interacting with each button variant
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Button variant="default">Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="link">Link</Button>
            </div>
          </div>
        </div>

        {/* Variants Specification */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold tracking-tight">Variants</h3>
            <p className="text-sm text-muted-foreground">
              Design tokens and specifications for each variant
            </p>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead>Background</TableHead>
                <TableHead>Text</TableHead>
                <TableHead>Border</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Default</TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    primary
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    primary-foreground
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Secondary</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                      secondary
                    </code>
                    <span className="text-xs text-muted-foreground">
                      (gray-100)
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    secondary-foreground
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Destructive</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                      destructive
                    </code>
                    <span className="text-xs text-muted-foreground">(red)</span>
                  </div>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    destructive-foreground
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Outline</TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    background
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    foreground
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    border
                  </code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Ghost</TableCell>
                <TableCell className="text-muted-foreground">
                  transparent
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    primary
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Link</TableCell>
                <TableCell className="text-muted-foreground">
                  transparent
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    primary
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
              </TableRow>
            </TableBody>
          </Table>

          {/* Common Styles */}
          <div className="rounded-xl border border-border bg-muted/30 p-6">
            <h4 className="text-sm font-semibold text-foreground mb-4">
              Common styles
            </h4>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Border radius:
                </span>
                <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                  8px
                </code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Font size:
                </span>
                <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                  14px
                </code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Font weight:
                </span>
                <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                  500
                </code>
              </div>
            </div>
          </div>
        </div>

        {/* Interactive States */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold tracking-tight">
              Interactive states
            </h3>
            <p className="text-sm text-muted-foreground">
              Hover, click and hold, or press Tab to see different states in
              action
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                name: "Default",
                variant: "default",
                hover: "opacity 90%",
                active: "opacity 80%",
              },
              {
                name: "Secondary",
                variant: "secondary",
                hover: "opacity 80%",
                active: "opacity 70%",
              },
              {
                name: "Destructive",
                variant: "destructive",
                hover: "opacity 90%",
                active: "opacity 80%",
              },
              {
                name: "Outline",
                variant: "outline",
                hover: "bg-gray-50",
                active: "bg-gray-100",
              },
              {
                name: "Ghost",
                variant: "ghost",
                hover: "bg-accent",
                active: "accent/80",
              },
              {
                name: "Link",
                variant: "link",
                hover: "underline",
                active: "opacity 80%",
              },
            ].map((item) => (
              <div
                key={item.name}
                className="rounded-xl border border-border bg-card p-6"
              >
                <h4 className="text-sm font-semibold text-foreground mb-4">
                  {item.name}
                </h4>
                <Button
                  variant={
                    item.variant as
                      | "default"
                      | "destructive"
                      | "outline"
                      | "secondary"
                      | "ghost"
                      | "link"
                  }
                  className="w-full mb-4"
                >
                  Hover & Click Me
                </Button>
                <div className="space-y-1.5 text-xs text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground/50">•</span>
                    <span>
                      <span className="font-medium">Hover:</span> {item.hover}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground/50">•</span>
                    <span>
                      <span className="font-medium">Active:</span> {item.active}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Focus State */}
          <div className="rounded-xl border border-border bg-muted/30 p-6">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-semibold text-foreground">
                Focus state
              </h4>
              <span className="text-xs text-muted-foreground px-3 py-1 rounded-full bg-background border border-border">
                Press Tab ⇥
              </span>
            </div>
            <div className="flex gap-3 mb-4">
              <Button variant="default">Tab 1</Button>
              <Button variant="secondary">Tab 2</Button>
              <Button variant="outline">Tab 3</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Keyboard navigation shows a 2px focus ring with primary color and
              2px offset
            </p>
          </div>

          {/* State Specifications */}
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="bg-muted/50 px-6 py-4 border-b border-border">
              <h4 className="text-sm font-semibold text-foreground">
                State specifications
              </h4>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-4">
                <div className="w-32 text-sm font-medium text-foreground">
                  Hover
                </div>
                <div className="flex-1 text-sm text-muted-foreground">
                  Transition duration 200ms with opacity or background color
                  change
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-32 text-sm font-medium text-foreground">
                  Active
                </div>
                <div className="flex-1 text-sm text-muted-foreground">
                  More pronounced opacity/background change than hover state
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-32 text-sm font-medium text-foreground">
                  Focus
                </div>
                <div className="flex-1 text-sm text-muted-foreground">
                  2px ring with primary color (ring-600) and 2px offset for
                  visibility
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-32 text-sm font-medium text-foreground">
                  Disabled
                </div>
                <div className="flex-1 text-sm text-muted-foreground">
                  50% opacity with pointer-events disabled
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sizes */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold tracking-tight">Sizes</h3>
            <p className="text-sm text-muted-foreground">
              Four size variants for different contexts
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-8">
            <div className="flex flex-wrap items-center gap-4">
              <Button size="sm" variant="outline">
                Small
              </Button>
              <Button size="default" variant="outline">
                Default
              </Button>
              <Button size="lg" variant="outline">
                Large
              </Button>
              <Button size="icon" variant="outline">
                <IconSettings className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Size</TableHead>
                <TableHead>Height</TableHead>
                <TableHead>Padding</TableHead>
                <TableHead>Use Case</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Small</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    36px
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    12px
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Compact spaces, toolbars
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Default</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    40px
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    16px
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Standard actions, forms
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Large</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    48px
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    48px × 12px
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Primary CTAs, hero sections
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Icon</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    40px
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    40px
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Icon-only buttons, toolbars
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        {/* With Icons */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold tracking-tight">
              With icons
            </h3>
            <p className="text-sm text-muted-foreground">
              Combine text with icons for clearer actions
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-8">
            <div className="flex flex-wrap gap-4">
              <Button>
                <IconCheck className="mr-2 h-4 w-4" />
                Confirm
              </Button>
              <Button variant="outline">
                <IconTrash className="mr-2 h-4 w-4" />
                Delete
              </Button>
              <Button variant="ghost">
                Settings
                <IconSettings className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/30 p-6">
            <h4 className="text-sm font-semibold text-foreground mb-4">
              Icon guidelines
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Icon size:
                </span>
                <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                  16px (h-4 w-4)
                </code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Spacing:</span>
                <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                  8px (mr-2/ml-2)
                </code>
              </div>
            </div>
          </div>
        </div>
      </section>
    </TooltipProvider>
  );
}

// Input Component Page
function InputComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Input</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Text input fields for collecting user data with support for various
          input types and states.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Try interacting with the input field
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-4">
            <Input placeholder="Enter your text here..." />
          </div>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Background</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  input
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    border
                  </code>
                  <span className="text-xs text-muted-foreground">
                    1px solid
                  </span>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border radius</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  8px (rounded-lg)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Height</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  40px (h-10)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Padding</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  8px 12px (px-3 py-2)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Text color</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  foreground
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Font size</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  14px (text-sm)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Placeholder</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  muted-foreground
                </code>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {/* Types */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Input types</h3>
          <p className="text-sm text-muted-foreground">
            Different HTML input types for various data formats
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium block">Text</label>
              <Input type="text" placeholder="Enter text..." />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">Email</label>
              <Input type="email" placeholder="email@example.com" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">Password</label>
              <Input type="password" placeholder="••••••••" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">Number</label>
              <Input type="number" placeholder="0" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">Search</label>
              <Input type="search" placeholder="Search..." />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">URL</label>
              <Input type="url" placeholder="https://example.com" />
            </div>
          </div>
        </div>
      </div>

      {/* States */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Interactive states
          </h3>
          <p className="text-sm text-muted-foreground">
            Click, focus, or interact to see different states
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          {[
            {
              name: "Default",
              disabled: false,
              description: "Standard input state ready for user input",
            },
            {
              name: "Focus",
              disabled: false,
              description: "2px ring with primary color when focused",
            },
            {
              name: "Disabled",
              disabled: true,
              description: "50% opacity with not-allowed cursor",
            },
            {
              name: "With Value",
              disabled: false,
              description: "Input with existing text content",
            },
          ].map((item) => (
            <div
              key={item.name}
              className="rounded-xl border border-border bg-card p-6"
            >
              <h4 className="text-sm font-semibold text-foreground mb-4">
                {item.name}
              </h4>
              <Input
                placeholder={
                  item.name === "With Value" ? "" : `${item.name} state`
                }
                disabled={item.disabled}
                defaultValue={item.name === "With Value" ? "Example text" : ""}
                className="mb-4"
              />
              <p className="text-xs text-muted-foreground">
                {item.description}
              </p>
            </div>
          ))}
        </div>

        {/* State Specifications */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="bg-muted/50 px-6 py-4 border-b border-border">
            <h4 className="text-sm font-semibold text-foreground">
              State specifications
            </h4>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-start gap-4">
              <div className="w-32 text-sm font-medium text-foreground">
                Default
              </div>
              <div className="flex-1 text-sm text-muted-foreground">
                Standard appearance with border and input background color
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-32 text-sm font-medium text-foreground">
                Hover
              </div>
              <div className="flex-1 text-sm text-muted-foreground">
                Subtle visual feedback on mouse over
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-32 text-sm font-medium text-foreground">
                Focus
              </div>
              <div className="flex-1 text-sm text-muted-foreground">
                2px focus ring with primary color (ring-600) for clear
                visibility
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-32 text-sm font-medium text-foreground">
                Disabled
              </div>
              <div className="flex-1 text-sm text-muted-foreground">
                50% opacity with pointer-events disabled and not-allowed cursor
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-32 text-sm font-medium text-foreground">
                Error
              </div>
              <div className="flex-1 text-sm text-muted-foreground">
                Red border color to indicate validation error
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* With Labels and Descriptions */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            With labels & descriptions
          </h3>
          <p className="text-sm text-muted-foreground">
            Properly labeled inputs with helper text
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium block">Username</label>
              <Input placeholder="Enter your username" />
              <p className="text-xs text-muted-foreground">
                This will be your public display name.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">
                Email <span className="text-destructive">*</span>
              </label>
              <Input type="email" placeholder="email@example.com" />
              <p className="text-xs text-muted-foreground">
                We&apos;ll never share your email with anyone else.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">
                Company website
              </label>
              <Input type="url" placeholder="https://example.com" />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-muted/30 p-6">
          <h4 className="text-sm font-semibold text-foreground mb-4">
            Label guidelines
          </h4>
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <span className="text-sm text-muted-foreground min-w-[120px]">
                Label font:
              </span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                14px medium (500)
              </code>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sm text-muted-foreground min-w-[120px]">
                Description font:
              </span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                12px muted
              </code>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sm text-muted-foreground min-w-[120px]">
                Vertical spacing:
              </span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                8px (space-y-2)
              </code>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sm text-muted-foreground min-w-[120px]">
                Group spacing:
              </span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                24px (space-y-6)
              </code>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sm text-muted-foreground min-w-[120px]">
                Required mark:
              </span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                text-destructive
              </code>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground">
              <strong>Note:</strong> All elements in a labeled input group
              (label → input → description) use consistent 8px spacing via{" "}
              <code className="bg-background px-1 rounded">space-y-2</code>
            </p>
          </div>
        </div>
      </div>

      {/* With Icons */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">With icons</h3>
          <p className="text-sm text-muted-foreground">
            Enhanced inputs with icon indicators
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium block">Search</label>
              <div className="relative">
                <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search..." />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">Email</label>
              <div className="relative">
                <IconMail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  type="email"
                  placeholder="email@example.com"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium block">Phone</label>
              <div className="relative">
                <IconPhone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  type="tel"
                  placeholder="+1 (555) 000-0000"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-muted/30 p-6">
          <h4 className="text-sm font-semibold text-foreground mb-4">
            Icon guidelines
          </h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Icon size:</span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                16px (h-4 w-4)
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Icon position:
              </span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                left-3 top-1/2
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Input padding:
              </span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                pl-9
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Icon color:</span>
              <code className="text-xs bg-background px-2 py-1 rounded-md font-mono">
                muted-foreground
              </code>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Dialog Component Page
function DialogComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Dialog</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Modal overlay component for focused interactions that require user
          attention or input.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Example of a basic dialog layout
          </p>
        </div>
        <div className="rounded-xl border border-border bg-muted/30 p-8">
          <div className="max-w-lg mx-auto">
            <div className="border border-border rounded-xl p-6 bg-card shadow-lg">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Dialog title</h3>
                <p className="text-sm">
                  This is a dialog content area. You can place any content here.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline">Cancel</Button>
                  <Button>Confirm</Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Content background</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  card
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border radius</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  12px (rounded-xl)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Max width</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  512px (max-w-lg)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Padding</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  24px (p-6)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Title font</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  18px semibold (text-lg)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Description font</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  14px (text-sm)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Description color</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  muted-foreground
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Overlay background</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  black with opacity
                </code>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {/* Dialog Types */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Dialog types
          </h3>
          <p className="text-sm text-muted-foreground">
            Different dialog layouts for various use cases
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Confirmation Dialog */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-4">
              Confirmation dialog
            </h4>
            <div className="border border-border rounded-xl p-6 bg-card shadow-lg">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Delete account</h3>
                <p className="text-sm">
                  Are you sure you want to delete your account? This action
                  cannot be undone.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline">Cancel</Button>
                  <Button variant="destructive">Delete</Button>
                </div>
              </div>
            </div>
          </div>

          {/* Form Dialog */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-4">
              Form dialog
            </h4>
            <div className="border border-border rounded-xl p-6 bg-card shadow-lg">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Edit profile</h3>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium block">Name</label>
                    <Input placeholder="Enter your name" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium block">Email</label>
                    <Input type="email" placeholder="email@example.com" />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline">Cancel</Button>
                  <Button>Save</Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Tooltip Component Page
function TooltipComponentPage() {
  return (
    <TooltipProvider delayDuration={100}>
      <section className="space-y-12">
        {/* Header */}
        <div className="space-y-3">
          <h2 className="text-4xl font-bold tracking-tight">Tooltip</h2>
          <p className="text-lg text-muted-foreground max-w-3xl">
            Contextual information that appears on hover, providing additional
            details without cluttering the interface.
          </p>
        </div>

        {/* Preview Section */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
            <p className="text-sm text-muted-foreground">
              Hover over elements to see tooltips
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-8">
            <div className="flex gap-4">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline">Hover me</Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">Tooltip content</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon">
                    <IconInfoCircle className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">Information</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Specifications */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold tracking-tight">
              Specifications
            </h3>
            <p className="text-sm text-muted-foreground">
              Design tokens and measurements
            </p>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>Token/Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Background</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    tooltip-bg (dark gray)
                  </code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Text color</TableCell>
                <TableCell>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    on-filled
                  </code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Font size</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    12px (text-xs)
                  </code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Padding</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    8px (p-2)
                  </code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Border radius</TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    6px (rounded-md)
                  </code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Animation</TableCell>
                <TableCell>
                  <span className="text-sm">
                    Fade in/out with slide transition
                  </span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>
    </TooltipProvider>
  );
}

// Checkbox Component Page
function CheckboxComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Checkbox</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Selection controls for binary choices, allowing users to select or
          deselect single or multiple options.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Try clicking the checkboxes
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-4">
            <div className="flex items-center gap-3">
              <Checkbox id="preview1" />
              <label
                htmlFor="preview1"
                className="text-sm font-medium cursor-pointer"
              >
                Option 1
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id="preview2" defaultChecked />
              <label
                htmlFor="preview2"
                className="text-sm font-medium cursor-pointer"
              >
                Option 2 (checked by default)
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Size</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  16px × 16px (h-4 w-4)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border radius</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  6px (rounded-md)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Unchecked state</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    bg: input
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    border: border
                  </code>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Checked state</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    bg: primary
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    checkmark: on-filled
                  </code>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Label font</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  14px medium (text-sm font-medium)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Description font</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    14px (text-sm)
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    muted-foreground
                  </code>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {/* Checkbox with Labels */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Basic checkbox
          </h3>
          <p className="text-sm text-muted-foreground">
            Simple checkbox with label
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-4">
            <div className="flex items-center gap-3">
              <Checkbox id="option1" />
              <label
                htmlFor="option1"
                className="text-sm font-medium cursor-pointer"
              >
                Option 1
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id="option2" />
              <label
                htmlFor="option2"
                className="text-sm font-medium cursor-pointer"
              >
                Option 2
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id="option3" />
              <label
                htmlFor="option3"
                className="text-sm font-medium cursor-pointer"
              >
                Option 3
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* With Description */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            With description
          </h3>
          <p className="text-sm text-muted-foreground">
            Checkbox with additional context for clarity
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-6">
            <div className="flex items-start gap-3">
              <Checkbox id="terms" className="mt-0.5" />
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="terms"
                  className="text-sm font-medium leading-none cursor-pointer"
                >
                  Accept terms and conditions
                </label>
                <p className="text-sm text-muted-foreground">
                  You agree to our Terms of Service and Privacy Policy
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox id="marketing" className="mt-0.5" />
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="marketing"
                  className="text-sm font-medium leading-none cursor-pointer"
                >
                  Receive marketing emails
                </label>
                <p className="text-sm text-muted-foreground">
                  Get updates about new features and special offers
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive States */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Interactive states
          </h3>
          <p className="text-sm text-muted-foreground">
            Different checkbox states and behaviors
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md space-y-4">
            <div className="flex items-center gap-3">
              <Checkbox id="unchecked" />
              <label
                htmlFor="unchecked"
                className="text-sm font-medium cursor-pointer"
              >
                Unchecked
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id="checked" defaultChecked />
              <label
                htmlFor="checked"
                className="text-sm font-medium cursor-pointer"
              >
                Checked
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id="disabled" disabled />
              <label
                htmlFor="disabled"
                className="text-sm font-medium text-muted-foreground cursor-not-allowed"
              >
                Disabled
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id="disabled-checked" disabled defaultChecked />
              <label
                htmlFor="disabled-checked"
                className="text-sm font-medium text-muted-foreground cursor-not-allowed"
              >
                Disabled & Checked
              </label>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Select Component Page
function SelectComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Select</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Dropdown menu for selecting a single option from a list, with support
          for grouping and search functionality.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Click to open the dropdown
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md">
            <Select>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="option1">Option 1</SelectItem>
                <SelectItem value="option2">Option 2</SelectItem>
                <SelectItem value="option3">Option 3</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Trigger background</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  input
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    border
                  </code>
                  <span className="text-xs text-muted-foreground">
                    1px solid
                  </span>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border radius</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  8px (rounded-lg)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Height</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  36px (h-9)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Text</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    14px (text-sm)
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    foreground
                  </code>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Dropdown background</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  card
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Item hover</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    bg: accent
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    text: accent-foreground
                  </code>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Group label</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    14px (text-sm)
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    muted-foreground
                  </code>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {/* Grouped Select */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Grouped options
          </h3>
          <p className="text-sm text-muted-foreground">
            Options organized into logical groups
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-md">
            <Select>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a region" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>North America</SelectLabel>
                  <SelectItem value="us">United States</SelectItem>
                  <SelectItem value="ca">Canada</SelectItem>
                  <SelectItem value="mx">Mexico</SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Europe</SelectLabel>
                  <SelectItem value="uk">United Kingdom</SelectItem>
                  <SelectItem value="fr">France</SelectItem>
                  <SelectItem value="de">Germany</SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Asia</SelectLabel>
                  <SelectItem value="jp">Japan</SelectItem>
                  <SelectItem value="cn">China</SelectItem>
                  <SelectItem value="kr">South Korea</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </section>
  );
}

// Popover Component Page
function PopoverComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Popover</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Floating content containers that appear on click, displaying
          additional information or controls without navigating away from the
          current context.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Click the button to open the popover
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="flex justify-center">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Open Popover</Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="space-y-2">
                  <h4 className="font-medium">Popover title</h4>
                  <p className="text-sm text-muted-foreground">
                    This is popover content. It can contain any information or
                    interactive elements.
                  </p>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Background</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  card
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    border
                  </code>
                  <span className="text-xs text-muted-foreground">
                    1px solid
                  </span>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Border radius</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  8px (rounded-lg)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Shadow</TableCell>
              <TableCell>
                <span className="text-sm">Drop shadow (elevation effect)</span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Padding</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  16px (p-4)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Default width</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  288px (w-72)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Text</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    14px (text-sm)
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    foreground
                  </code>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// Table Component Page
function TableComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Table</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Structured data display in rows and columns, ideal for presenting
          tabular information with clear visual hierarchy.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Basic data table example
          </p>
        </div>
        <div className="rounded-xl border border-border bg-muted/30 p-8">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">John Doe</TableCell>
                <TableCell>john@example.com</TableCell>
                <TableCell>Developer</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Jane Smith</TableCell>
                <TableCell>jane@example.com</TableCell>
                <TableCell>Designer</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Bob Johnson</TableCell>
                <TableCell>bob@example.com</TableCell>
                <TableCell>Product Manager</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Container border</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  border
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Container radius</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  8px (rounded-lg)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Header background</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  muted
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Header height</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  40px (h-10)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Header text</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    14px medium (text-sm font-medium)
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    foreground
                  </code>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Cell padding</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  16px (p-4)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Cell text</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  14px (text-sm)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Row border</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    border-b: border
                  </code>
                  <span className="text-xs text-muted-foreground">
                    (last row: no border)
                  </span>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Row hover</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  bg: muted/50
                </code>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// CopyButton Component Page
function CopyButtonComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Copy button</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          One-click clipboard copy functionality with visual feedback, commonly
          used in code snippets and documentation.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Click the copy icon to copy text to clipboard
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="max-w-2xl space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-border bg-background-50 p-3 font-mono text-sm">
              <code>npm install @vm0/cli</code>
              <CopyButton text="npm install @vm0/cli" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-background-50 p-3 font-mono text-sm">
              <code>pnpm add @vm0/ui</code>
              <CopyButton text="pnpm add @vm0/ui" />
            </div>
          </div>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Button padding</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  8px (p-2)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Button radius</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  6px (rounded-md)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Icon size</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  16px (h-4 w-4)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Icon color</TableCell>
              <TableCell>
                <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                  muted-foreground
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Hover state</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    bg: muted
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    icon: foreground
                  </code>
                </div>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Copied state</TableCell>
              <TableCell>
                <span className="text-sm">
                  Green check icon with success color
                </span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Code block</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    bg: background-50
                  </code>
                  <code className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded border border-primary-200 font-mono">
                    border: border
                  </code>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    rounded: 8px
                  </code>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// Icons Component Page
function IconsComponentPage() {
  return (
    <section className="space-y-12">
      {/* Header */}
      <div className="space-y-3">
        <h2 className="text-4xl font-bold tracking-tight">Icons</h2>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Tabler Icons integration providing a comprehensive set of clean,
          consistent icons for the entire design system.
        </p>
      </div>

      {/* Preview Section */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Preview</h3>
          <p className="text-sm text-muted-foreground">Commonly used icons</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="grid grid-cols-4 gap-6 md:grid-cols-6 lg:grid-cols-8">
            <div className="flex flex-col items-center gap-2">
              <IconCheck className="h-6 w-6 text-primary" />
              <code className="text-xs">Check</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconX className="h-6 w-6 text-destructive" />
              <code className="text-xs">X</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconCopy className="h-6 w-6" />
              <code className="text-xs">Copy</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconSearch className="h-6 w-6" />
              <code className="text-xs">Search</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconSettings className="h-6 w-6" />
              <code className="text-xs">Settings</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconTrash className="h-6 w-6" />
              <code className="text-xs">Trash</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconInfoCircle className="h-6 w-6" />
              <code className="text-xs">Info</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconUser className="h-6 w-6" />
              <code className="text-xs">User</code>
            </div>
          </div>
        </div>
      </div>

      {/* Specifications */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Specifications
          </h3>
          <p className="text-sm text-muted-foreground">
            Design tokens and measurements
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Token/Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Icon library</TableCell>
              <TableCell>
                <span className="text-sm">
                  Tabler Icons (@tabler/icons-react)
                </span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Stroke width</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  1.5px (default)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Small size</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  16px (h-4 w-4)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Medium size</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  20px (h-5 w-5)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Large size</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  24px (h-6 w-6)
                </code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Extra large size</TableCell>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  32px (h-8 w-8)
                </code>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {/* Icon Sizes */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">Icon sizes</h3>
          <p className="text-sm text-muted-foreground">
            Standard icon size variations
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="flex items-end gap-8">
            <div className="flex flex-col items-center gap-3">
              <IconSettings className="h-4 w-4" />
              <div className="text-center">
                <code className="text-xs block">h-4 w-4</code>
                <span className="text-xs text-muted-foreground">16px</span>
              </div>
            </div>
            <div className="flex flex-col items-center gap-3">
              <IconSettings className="h-5 w-5" />
              <div className="text-center">
                <code className="text-xs block">h-5 w-5</code>
                <span className="text-xs text-muted-foreground">20px</span>
              </div>
            </div>
            <div className="flex flex-col items-center gap-3">
              <IconSettings className="h-6 w-6" />
              <div className="text-center">
                <code className="text-xs block">h-6 w-6</code>
                <span className="text-xs text-muted-foreground">24px</span>
              </div>
            </div>
            <div className="flex flex-col items-center gap-3">
              <IconSettings className="h-8 w-8" />
              <div className="text-center">
                <code className="text-xs block">h-8 w-8</code>
                <span className="text-xs text-muted-foreground">32px</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* All Icons */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Icon collection
          </h3>
          <p className="text-sm text-muted-foreground">
            Additional commonly used icons
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="grid grid-cols-6 gap-6">
            <div className="flex flex-col items-center gap-2">
              <IconMail className="h-6 w-6" />
              <code className="text-xs">Mail</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconPhone className="h-6 w-6" />
              <code className="text-xs">Phone</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconCalendar className="h-6 w-6" />
              <code className="text-xs">Calendar</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <IconBrandGithub className="h-6 w-6" />
              <code className="text-xs">GitHub</code>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
