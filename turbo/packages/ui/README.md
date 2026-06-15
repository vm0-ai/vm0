# @vm0/ui - Design System

VM0's shared UI component library with a complete design system including components, colors, and utilities.

## 📦 Package Overview

This package provides:

- **UI Components** - Pre-built React components (Button, Card, Input, Table, Dialog)
- **Icons** - Tabler Icons for consistent iconography
- **Color System** - Complete color palette with semantic mappings
- **Design Tokens** - Typography, spacing, and border radius
- **Utilities** - Helper functions like `cn()`

## 🎨 Design System

### Design Source

- **Figma**: https://www.figma.com/design/eTWIsjktpymTDYEb55OxXx/VM0-Cloud
- **Typography**: Noto Sans (Primary), Fira Code (Monospace)
- **Icons**: Tabler Icons (https://tabler.io/icons)
- **Primary Color**: `#ed4e01` (Orange)

### Typography

The design system uses **Noto Sans** as the primary typeface and **Fira Code** for code blocks.

#### Next.js Apps (Recommended)

```tsx
// app/layout.tsx
import { Noto_Sans, Fira_Code } from "next/font/google";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-noto-sans",
  display: "swap",
});

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-fira-code",
  display: "swap",
});

export default function RootLayout({ children }) {
  return (
    <html className={`${notoSans.variable} ${firaCode.variable}`}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
```

#### Other Apps

```css
/* Import from Google Fonts */
@import url("https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&family=Fira+Code:wght@400;500;600&display=swap");

body {
  font-family: "Noto Sans", system-ui, sans-serif;
}

code,
pre {
  font-family: "Fira Code", monospace;
}
```

---

## 🎨 Icons

VM0 uses **Tabler Icons** for all iconography, providing a consistent and comprehensive icon set.

### Installation

Tabler Icons is already included in the `@vm0/ui` package. For apps using it:

```bash
pnpm add @tabler/icons-react
```

### Usage

```tsx
import {
  IconRobot,
  IconChartBar,
  IconKey,
  IconReceipt
} from "@tabler/icons-react";

// Basic usage
<IconRobot size={16} />
<IconRobot size={20} />
<IconRobot size={24} />

// With custom styling
<IconRobot size={16} className="text-primary" />
<IconRobot size={20} stroke={1.5} />
<IconRobot size={24} color="#ed4e01" />

// In buttons
<Button>
  <IconRocket size={16} />
  Launch
</Button>
```

### Common Icons

| Icon | Component        | Use Case                 |
| ---- | ---------------- | ------------------------ |
| 🤖   | `IconRobot`      | Agents, AI features      |
| 📊   | `IconChartBar`   | Analytics, reports       |
| 🔑   | `IconKey`        | API keys, authentication |
| 🧾   | `IconReceipt`    | Billing, transactions    |
| ❓   | `IconHelpCircle` | Help, support            |
| 🚀   | `IconRocket`     | Getting started, launch  |
| 📋   | `IconList`       | Lists, logs              |
| ⚙️   | `IconSettings`   | Settings, configuration  |
| 🔔   | `IconBell`       | Notifications            |
| 👤   | `IconUser`       | User profile             |

### Icon Sizes

Follow these size guidelines:

- **16px** - Default for UI (buttons, nav items, form labels)
- **20px** - Medium size (headings, larger buttons)
- **24px** - Large (page headers, hero sections)
- **32px+** - Extra large (landing pages, empty states)

### Resources

- **Browse icons**: https://tabler.io/icons
- **React docs**: https://tabler.io/docs/icons/react
- **Total icons**: 5000+ free icons

---

## 🎨 Color System

### Base Color Palette

VM0 uses a **Tailwind-style color scale system** with complete palettes:

#### Primary (Orange Brand Color)

```tsx
primary-50   #FFFBF7  // Lightest
primary-100  #FCF3F0
primary-200  #FDE7DF
primary-300  #FFD5C5
primary-400  #FFC5B0
primary-500  #FFB69E
primary-600  #F4A288
primary-700  #EB8868
primary-800  #ED4E01  // Main brand color ⭐
primary-900  #DE3F00
primary-950  #D03200  // Darkest
```

#### Gray (Neutral Colors)

```tsx
gray-0    #FFFCF9  // Pure white (warm)
gray-50   #F9F4EF  // Lightest gray
gray-100  #F0EBE5
gray-200  #E8E2DD  // Borders
gray-300  #E1DBD5
gray-400  #D9D3CD
gray-500  #CEC8C2  // Medium
gray-600  #BAB5AF
gray-700  #8C8782  // Secondary text
gray-800  #827D77  // Body text
gray-900  #635E59
gray-950  #231F1B  // Darkest text
```

#### Divider

```tsx
divider  #EED5CB  // Subtle separators (light)
divider  #4A413E  // Subtle separators (dark)
```

### Semantic Colors

Semantic colors provide consistent theming across the application:

| Semantic Name        | Maps To       | Usage               |
| -------------------- | ------------- | ------------------- |
| `background`         | `gray-0`      | Page background     |
| `foreground`         | `gray-950`    | Primary text        |
| `card`               | `white`       | Card backgrounds    |
| `card-foreground`    | `gray-950`    | Text on cards       |
| `primary`            | `primary-700` | Main brand color    |
| `primary-foreground` | `gray-0`      | Text on primary     |
| `secondary`          | `gray-100`    | Secondary elements  |
| `muted`              | `gray-100`    | Muted backgrounds   |
| `muted-foreground`   | `gray-800`    | Secondary text      |
| `accent`             | `primary-100` | Accent highlights   |
| `border`             | `gray-200`    | Default borders     |
| `divider`            | `divider`     | Dividers            |
| `input`              | `gray-50`     | Input backgrounds   |
| `ring`               | `primary-600` | Focus rings         |
| `destructive`        | `red/600`     | Destructive actions |
| `sidebar`            | `gray-50`     | Sidebar background  |
| `sidebar-primary`    | `primary-800` | Active sidebar item |
| `sidebar-accent`     | `gray-100`    | Sidebar hover       |

### Color Usage Examples

```tsx
// ✅ Use semantic colors (recommended)
<div className="bg-background text-foreground">
  <Card className="bg-card border-border">
    <CardTitle className="text-card-foreground">Title</CardTitle>
    <CardDescription className="text-muted-foreground">
      Description
    </CardDescription>
  </Card>
</div>

// ✅ Use base colors for specific needs
<div className="bg-primary-50">      // Light background
<div className="bg-primary-800">     // Brand color
<div className="text-gray-700">      // Custom text shade
<div className="border-primary-200"> // Light brand border

// Gradients
<div className="bg-gradient-to-r from-primary-100 to-primary-800">

// With opacity
<div className="bg-primary-800/50">  // 50% transparent
```

---

## 🧩 Components

All components are built with Radix UI primitives and styled with Tailwind CSS.

### Button

```tsx
import { Button } from "@vm0/ui";

<Button variant="default">Default</Button>
<Button variant="destructive">Delete</Button>
<Button variant="outline">Outline</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="link">Link</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="default">Default</Button>
<Button size="lg">Large</Button>
<Button size="icon"><Icon /></Button>
```

**Variants:**

- `default` - Primary button (orange)
- `destructive` - Dangerous actions
- `outline` - Outlined button
- `secondary` - Secondary button
- `ghost` - Minimal button
- `link` - Link style

### Card

```tsx
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@vm0/ui";

<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card description text</CardDescription>
  </CardHeader>
  <CardContent>Main content goes here</CardContent>
  <CardFooter>Footer content</CardFooter>
</Card>;
```

### Input

```tsx
import { Input } from "@vm0/ui";

<Input type="text" placeholder="Enter text..." />
<Input type="email" placeholder="Email" />
<Input disabled placeholder="Disabled" />
```

### Table

```tsx
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@vm0/ui";

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Status</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>John Doe</TableCell>
      <TableCell>Active</TableCell>
    </TableRow>
  </TableBody>
</Table>;
```

### Dialog

```tsx
import { Dialog } from "@vm0/ui";

// Based on Radix UI Dialog primitive
// See Radix UI docs for full API
```

---

## 🛠️ Utilities

### cn() - Class Name Utility

Intelligently merges and deduplicates Tailwind class names.

```tsx
import { cn } from "@vm0/ui";

cn("px-2 py-1", "px-4"); // => "px-4 py-1"
cn("text-red-500", undefined); // => "text-red-500"
cn("bg-primary", isActive && "bg-primary-700"); // Conditional
```

---

## 📐 Design Tokens

### Border Radius

```css
--radius-xl: 14px --radius-lg: 8px (default) --radius-md: 6px --radius-sm: 4px;
```

```tsx
<div className="rounded-lg">  // Default radius
<div className="rounded-md">  // Medium radius
<div className="rounded-sm">  // Small radius
```

### Typography

```css
/* Font Families */
--font-family-sans:
  Noto Sans, system-ui, sans-serif --font-family-mono: Fira Code, monospace;
```

**Font Sizes:**

```css
--font-size-2xl: 24px --font-size-lg: 18px --font-size-sm: 14px
  --font-size-xs: 12px;
```

**Line Heights:**

```css
--line-height-8: 32px --line-height-7: 28px --line-height-5: 20px
  --line-height-4: 16px;
```

**Usage:**

```tsx
<div className="font-sans">     // Noto Sans
<div className="font-mono">     // Fira Code
<p className="text-lg">         // 18px
<p className="text-sm">         // 14px
```

---

## 🎯 Usage Guide

### Installation

This package is part of the VM0 monorepo and uses workspace protocol:

```json
{
  "dependencies": {
    "@vm0/ui": "workspace:*"
  }
}
```

### Import Components

```tsx
// Import components
import { Button, Card, Input } from "@vm0/ui";

// Import styles (in your app's layout/entry)
import "@vm0/ui/styles/globals.css";

// Import utilities
import { cn } from "@vm0/ui/lib/utils";
```

### Theme Setup

The design system automatically supports light/dark themes using CSS variables.

```tsx
// Toggle theme
<html className="dark">  // Dark mode
<html className="light"> // Light mode (default)
```

---

## 🎨 Design Principles

### 1. Use Semantic Colors First

```tsx
✅ Good: <Button variant="default">
❌ Avoid: <Button className="bg-primary-800">
```

### 2. Maintain Contrast

```tsx
✅ Good: bg-gray-50 + text-gray-950
✅ Good: bg-primary + text-primary-foreground
❌ Bad: bg-gray-100 + text-gray-200
```

### 3. Consistent Spacing

Use Tailwind's spacing scale (4px increments):

- `p-2` (8px), `p-4` (16px), `p-6` (24px), `p-8` (32px)

### 4. Component Composition

Build complex UIs from simple components:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Dashboard</CardTitle>
  </CardHeader>
  <CardContent>
    <Table>{/* table content */}</Table>
  </CardContent>
</Card>
```

---

## 📱 Common Patterns

### Page Layout

```tsx
<div className="min-h-screen bg-background text-foreground">
  <header className="border-b border-border">
    <nav className="container mx-auto px-4 py-4">{/* Navigation */}</nav>
  </header>
  <main className="container mx-auto px-4 py-8">{/* Main content */}</main>
  <footer className="border-t border-divider">{/* Footer */}</footer>
</div>
```

### Sidebar Navigation

```tsx
<aside className="w-64 bg-sidebar border-r border-border">
  <nav className="space-y-1 p-4">
    <a
      href="#"
      className="flex items-center gap-3 px-3 py-2 rounded-md
                 bg-sidebar-primary text-sidebar-primary-foreground"
    >
      <HomeIcon />
      <span>Home (Active)</span>
    </a>
    <a
      href="#"
      className="flex items-center gap-3 px-3 py-2 rounded-md
                 text-sidebar-foreground hover:bg-sidebar-accent"
    >
      <SettingsIcon />
      <span>Settings</span>
    </a>
  </nav>
</aside>
```

### Form

```tsx
<form className="space-y-4">
  <div>
    <label className="block text-sm font-medium text-foreground mb-1">
      Email
    </label>
    <Input type="email" className="w-full" placeholder="you@example.com" />
    <p className="text-sm text-muted-foreground mt-1">
      We'll never share your email
    </p>
  </div>

  <Button type="submit" className="w-full">
    Submit
  </Button>
</form>
```

### List with Dividers

```tsx
<div className="divide-y divide-divider">
  {items.map((item) => (
    <div
      key={item.id}
      className="py-4 hover:bg-accent hover:text-accent-foreground"
    >
      {item.content}
    </div>
  ))}
</div>
```

---

## 🔧 Development

### Project Structure

```
packages/ui/
├── src/
│   ├── components/ui/     # UI components
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── input.tsx
│   │   ├── table.tsx
│   │   └── dialog.tsx
│   ├── lib/
│   │   └── utils.ts       # Utility functions
│   ├── styles/
│   │   └── globals.css    # Global styles & theme
│   └── index.ts           # Main export
├── tailwind.config.ts     # Tailwind configuration
├── components.json        # shadcn/ui config
└── package.json
```

### Scripts

```bash
pnpm lint         # Run linter
pnpm check-types  # Type check
pnpm test         # Run tests
```

### Adding New Components

1. Create component in `src/components/ui/`
2. Export from `src/index.ts`
3. Use semantic colors and design tokens
4. Write tests in `__tests__/`

Example:

```tsx
// src/components/ui/badge.tsx
import { cn } from "../../lib/utils";

export function Badge({ className, ...props }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs",
        "bg-primary text-primary-foreground",
        className,
      )}
      {...props}
    />
  );
}

// src/index.ts
export { Badge } from "./components/ui/badge";
```

---

## 🎨 Customization

### Modifying Colors

Edit `src/styles/globals.css`:

```css
:root {
  /* Change primary brand color */
  --primary-800: 16 97% 46%; /* #ED4E01 */

  /* Adjust gray scale */
  --gray-200: 28 18% 90%; /* #E8E2DD */
}
```

### Adding New Color Scales

1. Add CSS variables in `globals.css`
2. Add to `@theme` section
3. Update `tailwind.config.ts`

```css
/* globals.css */
:root {
  --success-500: 142 76% 36%;
  --success-600: 142 72% 29%;
}

@theme {
  --color-success-500: hsl(var(--success-500));
  --color-success-600: hsl(var(--success-600));
}
```

```ts
// tailwind.config.ts
colors: {
  success: {
    500: "hsl(var(--success-500))",
    600: "hsl(var(--success-600))",
  }
}
```

---

## 📚 Resources

- [Figma Design File](https://www.figma.com/design/eTWIsjktpymTDYEb55OxXx/VM0-Cloud)
- [shadcn/ui Documentation](https://ui.shadcn.com/)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Radix UI](https://www.radix-ui.com/)
- [Class Variance Authority](https://cva.style/docs)

---

## 🤝 Contributing

When contributing to the design system:

1. **Follow existing patterns** - Match the style of existing components
2. **Use semantic colors** - Don't hardcode color values
3. **Write tests** - Add tests for new components
4. **Update docs** - Document new features
5. **Check types** - Run `pnpm check-types` before committing

---

**Maintainer**: VM0 Team  
**Version**: 0.0.0  
**Last Updated**: January 2026
