---
name: ui-design
description: Design guidelines and component inventory for building platform UI. Load before any frontend feature work to ensure consistency, reuse, and dark mode support.
---

# UI Design Skill

This skill provides the design system reference, component inventory, and layout patterns for the vm0 platform app. **Load this before starting any UI work** to ensure you reuse existing components and maintain visual consistency.

## Arguments

Your args are: `$ARGUMENTS`

If args are provided, treat them as a description of what you're about to design/build. Use it to narrow which sections below are most relevant.

## Core Design Principles

### 1. Reuse First
Before creating anything new, check if an existing component or pattern already solves it. Search the codebase:
```bash
# Find existing components
ls turbo/packages/ui/src/components/ui/
ls turbo/apps/platform/src/views/zero-page/components/
# Find similar patterns
grep -rn "ComponentName\|pattern-keyword" turbo/apps/platform/src/views/
```

### 2. Consistency Over Novelty
Match existing pages exactly. Same spacing, same border radius, same colors. When in doubt, copy the pattern from the nearest similar page.

### 3. Progressive Disclosure
Show the minimum needed upfront. Hide advanced options behind expandable sections, "More" buttons, or secondary tabs. Don't overwhelm the user.

### 4. Dark Mode Always
Every color must work in both themes. Use design tokens (CSS variables), never hardcode colors. Test both themes before committing.

### 5. Simplicity
Fewer elements = better. If you can remove a UI element without losing clarity, remove it.

### 6. Consider Dependencies
Before adding new components or libraries, check if an existing one can do the job. Avoid adding dependencies for single-use cases.

## Design Tokens

All colors use HSL CSS variables. **Never hardcode hex/rgb values.**

### Border System (0.7px)
The entire app uses `0.7px` borders with `hsl(var(--gray-400))` color. This is the single most important visual pattern:

```
Cards, inputs, dropdowns, buttons (outline) = 0.7px solid hsl(var(--gray-400))
```

Available CSS utility classes (defined in `turbo/apps/platform/src/views/css/index.css`):
| Class | Usage |
|-------|-------|
| `.zero-border` | `border: 0.7px solid hsl(var(--gray-400))` |
| `.zero-border-t` | Top border only |
| `.zero-border-r` | Right border (gray-300) |
| `.zero-border-dashed` | Dashed border |
| `.zero-border-dashed-t` | Dashed top border |
| `.zero-badge` | Border + gray-0 background (for status pills) |

### Color Tokens
| Token | Usage |
|-------|-------|
| `hsl(var(--foreground))` | Primary text |
| `hsl(var(--muted-foreground))` | Secondary text |
| `hsl(var(--card))` | Card/surface background |
| `hsl(var(--background))` | Page background |
| `hsl(var(--primary))` | Accent/brand color (#ed4e01) |
| `hsl(var(--gray-0))` through `hsl(var(--gray-950))` | Gray scale |
| `hsl(var(--border))` | Generic border color |
| `hsl(var(--destructive))` | Error/danger |

### Spacing & Radius
| Value | Tailwind | Usage |
|-------|----------|-------|
| 0.75rem | `rounded-xl` | Cards, dialogs, large containers |
| 0.5rem | `rounded-lg` | Buttons, inputs, dropdowns, small cards |
| 0.375rem | `rounded-md` | Badges, small elements |

## Component Inventory

### UI Library (`@vm0/ui`)
Import from `@vm0/ui` or `@vm0/ui/components/ui/*`:

| Component | Key props | Notes |
|-----------|-----------|-------|
| `Button` | `variant="default\|outline\|destructive\|ghost\|link"`, `size="default\|sm\|lg\|icon"` | Outline variant has 0.7px border |
| `Input` | Standard HTML input props | Default: h-9, rounded-lg, 0.7px border, bg-input |
| `Select` / `SelectTrigger` / `SelectContent` / `SelectItem` | Radix-based | 0.7px borders on trigger and content |
| `Dialog` / `DialogContent` / `DialogHeader` / `DialogTitle` | Radix-based | sm:rounded-xl, 0.7px border |
| `DropdownMenu` / `DropdownMenuContent` / `DropdownMenuItem` | Radix-based | 0.7px border, rounded-lg |
| `Popover` / `PopoverContent` | Radix-based | 0.7px border |
| `Tabs` / `TabsList` / `TabsTrigger` | Radix-based | Use `.zero-tabs` class for app-style tabs |
| `Card` / `CardContent` / `CardHeader` | Layout wrapper | Combine with `.zero-card` class |
| `Sheet` / `SheetContent` | Side drawer | Animated slide-in |
| `Switch` | `size="sm"`, `checked`, `onCheckedChange` | Toggle control |
| `Skeleton` | `className` | Loading placeholder |
| `Tooltip` / `TooltipProvider` / `TooltipContent` | Hover hints | Wrap with TooltipProvider |
| `Checkbox` | Standard | |
| `Table` / `TableHeader` / `TableRow` / `TableCell` | HTML table wrapper | |

### App-Level CSS Classes
Defined in `turbo/apps/platform/src/views/css/index.css`. Must be inside `.zero-app` ancestor:

| Class | Visual |
|-------|--------|
| `.zero-card` | White card: 0.7px border, rounded-xl, bg-card |
| `.zero-card-morandi` | Card with hover state + shadow |
| `.zero-chip` | Gray pill: 0.7px border, bg-gray-50, hover:bg-gray-100 |
| `.zero-btn-morandi` | Outline button: 0.7px border, bg-gray-50 |
| `.zero-pill` | Status badge: 0.7px border, bg-gray-0 |
| `.zero-tabs` | Tab container with selected state |
| `.zero-composer` | Chat input card with shadow |
| `.zero-search-input` | Search input container |
| `.zero-shimmer-text` | Animated shimmer for loading text |
| `.zero-dashed-line` | Vertical dashed connector line |

### Common View Components
Located in `turbo/apps/platform/src/views/zero-page/components/`:

| Component | File | Usage |
|-----------|------|-------|
| `Pagination` | `../components/pagination.tsx` | Page navigation with rows-per-page |
| `LogTable` | `components/log-views/log-table.tsx` | Activity/run log table |
| `StatusBadge` | `components/log-views/status-badge.tsx` | Run status pill |
| `ConnectorIcon` | `components/settings/connector-icons.tsx` | Connector service icons |
| `TiptapInstructionsEditor` | `tiptap-instructions-editor.tsx` | Rich text editor |
| `ZeroUnsavedBar` | `zero-unsaved-bar.tsx` | Floating save/discard bar |

## Page Layout Patterns

### Standard Page Layout
Most pages follow this structure:
```tsx
<div className="flex flex-1 flex-col min-h-0">
  {/* Fixed header */}
  <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
    <div className="mx-auto max-w-[900px]">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">Title</h1>
      <p className="text-sm text-muted-foreground">Description</p>
    </div>
  </header>

  {/* Scrollable content */}
  <div className="flex-1 min-h-0 overflow-auto px-4 sm:px-6 pt-4">
    <div className="mx-auto max-w-[900px]">
      {/* Content here */}
    </div>
  </div>
</div>
```

### Card Section Pattern
Settings, billing, members pages use this pattern for grouped content:
```tsx
<section className="flex flex-col gap-3">
  <h3 className="text-sm font-medium text-foreground">Section Title</h3>
  <div className="overflow-hidden rounded-xl bg-card zero-border">
    {/* Rows with zero-border-t dividers */}
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Label</p>
        <p className="text-[13px] text-muted-foreground mt-0.5">Help text</p>
      </div>
      <Button variant="outline" size="sm">Action</Button>
    </div>
    <div className="h-0 zero-border-t mx-5" />
    {/* Next row... */}
  </div>
</section>
```

### Table-in-Card Pattern
Activity and schedule pages put tables inside cards. The table owns horizontal padding for full-width hover:
```tsx
<div className="zero-card overflow-hidden pb-3">
  <LogTable ... />  {/* LogTable adds its own px-5 */}
</div>
```

### Search Input Pattern
Consistent search box with icon:
```tsx
<div className="relative">
  <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" size={15} stroke={1.5} />
  <Input placeholder="Search..." className="pl-9" />
</div>
```

### Dialog Pattern
Standard modal dialog:
```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="max-w-md">
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
    </DialogHeader>
    {/* Content */}
    <div className="flex justify-end gap-2 mt-4">
      <Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button onClick={onSubmit}>Confirm</Button>
    </div>
  </DialogContent>
</Dialog>
```

## Checklist Before Implementing

Run through this before writing any UI code:

1. **Component exists?** Search `@vm0/ui` and `views/zero-page/components/` first
2. **Page pattern exists?** Find the most similar page and copy its layout structure
3. **Dark mode?** Using CSS variables only? No hardcoded colors?
4. **Border consistency?** All borders use 0.7px / `zero-border` / component defaults?
5. **Radius consistency?** Cards = `rounded-xl`, inputs/buttons = `rounded-lg`
6. **Progressive disclosure?** Can anything be hidden behind an expand/toggle?
7. **Simplicity?** Can you remove any element without losing clarity?
8. **Dependencies?** Using only existing packages? No new npm installs needed?

## Quick Reference: File Locations

| What | Where |
|------|-------|
| UI components | `turbo/packages/ui/src/components/ui/` |
| Design tokens (CSS) | `turbo/packages/ui/src/styles/globals.css` |
| App CSS classes | `turbo/apps/platform/src/views/css/index.css` |
| Page views | `turbo/apps/platform/src/views/zero-page/` |
| Shared view components | `turbo/apps/platform/src/views/zero-page/components/` |
| Signals (state) | `turbo/apps/platform/src/signals/` |
| Router/routes | `turbo/apps/platform/src/types/route.ts` |
