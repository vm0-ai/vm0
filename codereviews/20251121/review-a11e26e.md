# Review: feat: migrate landing page to apps/web (#136)

**Commit:** a11e26e
**Author:** Ethan Zhang <ethan@vm0.ai>
**Date:** Fri Nov 21 17:09:20 2025 +0800

## Summary

This commit migrates the landing page from a separate `vm0_landing` repository to the main monorepo under `turbo/apps/web`. The migration includes:

- All landing page assets migrated to `/public/assets`
- Complete CSS styling in `landing.css` (2440 lines)
- React component `LandingPage.tsx` with client-side interactivity
- Updated layout and page configuration with Google Fonts
- UI text changes ("Get early access" → "Join waitlist")
- Updated footer copyright

## Code Smell Analysis

### ✅ Good Practices

- Proper use of React hooks (`useEffect`, `useRef`) for DOM manipulation
- Appropriate use of `Next/Image` component for optimized image loading
- Clean component structure with semantic sections
- Good CSS variable organization for theming
- Proper event listener cleanup in useEffect return function
- Responsive design considerations with media queries

### ⚠️ Issues Found

#### 1. **Excessive Inline DOM Manipulation** (Error Handling / Over-engineering)

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Lines:** 15-103
- **Issue:** Direct manipulation of the DOM using `document.querySelector` and inline style assignments (e.g., `navbar.style.background = ...`). This bypasses React's rendering model and creates maintenance issues.
- **Problem:** Mixes React component state with imperative DOM updates; harder to test and maintain than declarative React patterns.

#### 2. **Hard-coded Magic Numbers** (Code Quality)

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Lines:** 16, 25, 30, 35, 50, 75, 110
- **Issue:** Multiple magic numbers scattered throughout: `50`, `0.1`, `-50px`, `0.2`, `20px`, `-0.5`, `0.5`, `1`, `2`
- **Problem:** No constants or explanatory comments; difficult to understand what these values represent or adjust them later.

#### 3. **Particle Rendering Anti-pattern** (Bad Tests / Over-mocking adjacent)

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Lines:** 108-115
- **Issue:** `renderParticles()` function creates 30 hard-coded particle elements on every render. This is inefficient and could be better handled with CSS or CSS Grid.
- **Problem:** Generates unnecessary DOM nodes; no memoization; could cause performance issues.

#### 4. **Direct DOM Selection for Intersection Observer Setup** (Error Handling)

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Lines:** 43-57
- **Issue:** Uses `document.querySelectorAll()` to set up Intersection Observer for animation. This approach is fragile and couples the logic to specific CSS class names.
- **Problem:** If class names change, animations break silently. No error handling if selectors match nothing.

#### 5. **Hardcoded URL for Sign-up Navigation** (Hardcoded URLs)

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Lines:** 137, 174, 495, 672 (multiple occurrences of `href="/sign-up"`)
- **Issue:** Sign-up route is hardcoded in multiple places
- **Recommendation:** Extract to a constant at the top: `const SIGN_UP_URL = "/sign-up"` and reuse it

#### 6. **Very Large CSS File Without Modular Organization** (Code Quality)

- **File:** `/workspaces/vm01/turbo/apps/web/app/landing.css`
- **Lines:** 2440 total lines
- **Issue:** All styles in a single monolithic CSS file. No separation of concerns or modular structure.
- **Recommendation:** Split into logical modules:
  - `navbar.css` - Navigation styles
  - `hero.css` - Hero section
  - `features.css` - Feature cards
  - `animations.css` - Scroll animations and transitions
  - `responsive.css` - Media queries

#### 7. **Missing Accessibility Attributes**

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Issue:** SVG elements (connection lines) lack `aria-hidden` attributes. Particle elements lack semantic meaning.
- **Lines:** Various SVG and decorative elements throughout
- **Recommendation:** Add `aria-hidden="true"` to purely decorative SVG elements

#### 8. **Typo in Section Text** (QA Issue)

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Line:** 296
- **Issue:** "Suppot all kinds" should be "Support all kinds"
- **Line:** 304
- **Issue:** "developennt" should be "development"
- **Line:** 299
- **Issue:** "Leverage Claude Code, Codex, Gemini, and other CLI agents" - copy editing quality issue

#### 9. **No Performance Optimizations for Image Loading**

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Issue:** Uses `Next/Image` component correctly, but no `priority` attribute on critical above-the-fold images (e.g., hero visual)
- **Recommendation:** Add `priority` to hero section images to prevent layout shift

#### 10. **Pointer Move Event Handler Without Debouncing** (Performance)

- **File:** `/workspaces/vm01/turbo/apps/web/app/components/LandingPage.tsx`
- **Lines:** 75-80
- **Issue:** `handlePointerMove` event fires on every mouse movement without debouncing; could cause performance issues with 3D transform calculations
- **Recommendation:** Add debouncing or use `requestAnimationFrame` for smooth 60fps updates

### 💡 Recommendations

1. **Refactor DOM manipulation into React patterns:**
   - Use React state for navbar styling instead of `document.querySelector`
   - Create a custom hook for Intersection Observer logic
   - Use CSS classes instead of inline style updates

2. **Extract constants and variables:**

   ```typescript
   const SIGN_UP_URL = "/sign-up";
   const SCROLL_THRESHOLD = 50;
   const PARTICLE_COUNT = 30;
   const TILT_MULTIPLIER = 20;
   ```

3. **Split large CSS file:**
   - Create separate CSS modules for each section
   - Use CSS custom properties for theming values
   - Consider CSS-in-JS solution if interactivity increases

4. **Add TypeScript interfaces for better type safety:**
   - Define types for particle data
   - Create interface for scroll state management

5. **Fix copy/typos before merging:**
   - "Suppot" → "Support"
   - "developennt" → "development"

6. **Add performance monitoring:**
   - Monitor 3D transform performance on slower devices
   - Use `requestAnimationFrame` for scroll-based animations

## Breaking Changes

- None. This is a pure feature migration with no API or interface changes.

## Code Quality Score: 6.5/10

**Strengths:** Functional implementation, responsive design, proper React fundamentals
**Weaknesses:** DOM manipulation patterns, missing optimizations, code organization, copy quality
