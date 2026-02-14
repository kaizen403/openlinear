# Landing Pages Visual Redesign — Add Miniature Component Graphics

## TL;DR

> **Quick Summary**: Redesign the 4 secondary landing pages (product, enterprise, pricing, contact) to match the main page's visual quality by adding miniature UI component graphics (glass-panel floating cards, mock UI mockups), replacing generic bullet-list walls with visual representations, and upgrading heroes with atmospheric backgrounds.
> 
> **Deliverables**:
> - Product page with mock UI graphics for task model, execution engine, and batch system
> - Enterprise page with floating glass-panel elements and mock settings/log panels
> - Pricing page with enhanced hero and richer card treatments
> - Contact page with atmospheric hero and decorative glass-panel elements
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 4 waves (1 pre-check + 4 parallel page tasks)
> **Critical Path**: Task 1 (build check) → Tasks 2-5 (all pages in parallel)

---

## Context

### Original Request
The secondary landing pages (product, enterprise, pricing, contact) look AI-generated — walls of repeating bullet lists with alternating background sections, zero graphics. The main landing page has rich floating glass panels, mock UI components, atmospheric backgrounds, and animations. The secondary pages need miniature component graphics added to look realistic and appealing.

### Interview Summary
**Key Discussions**:
- Main page is the reference standard — do not modify it
- All pages already share consistent `px-[100px]` margins
- The existing design system (`glass-panel`, `mock-card`, `glass-card`, `animate-float-*`) provides all needed CSS classes
- Docs page is excluded (documentation layout, not marketing)

**Research Findings**:
- `FeatureMock` component in `feature-sections.tsx:75-99` is the exact mock-card pattern needed (window chrome dots, title bar, structured rows) — but it's a local function, not exported
- `glass-card` CSS class (defined in `globals.css:120-161`) exists but is **unused anywhere** — available for this work
- Contact page is the only `"use client"` component — form state (`useState`) must not be disturbed
- All floating elements in the hero use `hidden lg:block` — new decorative elements must follow this pattern
- Enterprise hero already has atmospheric background; product, pricing, contact heroes are plain `bg-background`

### Metis Review
**Identified Gaps** (addressed):
- **Mobile responsiveness**: All new floating/decorative elements must use `hidden lg:block` — added as guardrail
- **Contact page hydration**: Form JSX hierarchy must remain untouched — decorative elements added as siblings only
- **Scope cap on graphics**: Capped at 3-4 miniature graphics per page to prevent visual overload
- **No shared component extraction**: Keep modifications inline in each page file to prevent architecture creep

---

## Work Objectives

### Core Objective
Transform 4 secondary landing pages from text-heavy AI-template layouts into visually rich marketing pages with miniature UI component graphics, using the established design system.

### Concrete Deliverables
- Modified `apps/landing/app/product/page.tsx` — with 3-4 mock UI graphics
- Modified `apps/landing/app/enterprise/page.tsx` — with 2-3 glass-panel/mock elements
- Modified `apps/landing/app/pricing/page.tsx` — with enhanced hero and card treatments
- Modified `apps/landing/app/contact/page.tsx` — with atmospheric hero and decorative elements

### Definition of Done
- [ ] All 4 pages have miniature component graphics (not just text + bullets)
- [ ] Each page uses existing CSS classes (`glass-panel`, `mock-card`, `glass-card`, `animate-float-*`)
- [ ] New decorative elements are hidden on mobile (`hidden lg:block`)
- [ ] Contact form still functions (fields present, interactive, submittable)
- [ ] No console errors on any page
- [ ] Build succeeds

### Must Have
- Atmospheric hero backgrounds on product, pricing, contact pages (enterprise already has one)
- At least 2 mock UI graphics per page replacing text-only sections
- Floating glass-panel elements on pages where appropriate
- All existing text content preserved (format changed, not deleted)

### Must NOT Have (Guardrails)
- No changes to the main landing page (`app/page.tsx`) or any of its components
- No new shared component files — keep modifications scoped to the 4 page files
- No new CSS animation keyframes — reuse existing `animate-float-1` through `animate-float-5`
- No new npm dependencies
- No conversion of server components to client components (except contact which is already client)
- No changes to `px-[100px]` margins (responsive fix is separate scope)
- No refactoring of existing section structure before adding visual enhancements
- No modification of the contact form's component structure, state management, or submit handler
- No per-page SEO metadata changes
- No `prefers-reduced-motion` additions
- No dark/light mode changes (theme is force-locked to dark)
- No premature abstraction — no shared `<Section>` wrapper, no shared `<PageHero>`, no shared `<BulletList>` component

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: NO (no test framework in landing app)
- **Automated tests**: None
- **Framework**: N/A

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

> QA scenarios are the PRIMARY verification method. The executing agent will directly
> run the deliverable and verify it using Playwright for browser UI and Bash for builds.

**Verification Tool by Deliverable Type:**

| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| **Page UI** | Playwright (playwright skill) | Navigate, assert DOM elements exist, screenshot |
| **Build** | Bash | Run `next build`, assert exit 0 |
| **TypeScript** | Bash (lsp_diagnostics) | Check for type errors |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
└── Task 1: Pre-flight build check

Wave 2 (After Wave 1):
├── Task 2: Product page redesign
├── Task 3: Enterprise page redesign
├── Task 4: Pricing page redesign
└── Task 5: Contact page redesign

Wave 3 (After Wave 2):
└── Task 6: Final build verification + visual QA across all pages
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2, 3, 4, 5 | None |
| 2 | 1 | 6 | 3, 4, 5 |
| 3 | 1 | 6 | 2, 4, 5 |
| 4 | 1 | 6 | 2, 3, 5 |
| 5 | 1 | 6 | 2, 3, 4 |
| 6 | 2, 3, 4, 5 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1 | quick |
| 2 | 2, 3, 4, 5 | visual-engineering with frontend-design skill (parallel) |
| 3 | 6 | quick with playwright skill |

---

## TODOs

- [ ] 1. Pre-flight Build Check

  **What to do**:
  - Run `pnpm --filter landing build` (or `npx next build` from `apps/landing`) to verify the project builds successfully before any changes
  - Run `lsp_diagnostics` on the 4 target page files to confirm zero pre-existing TypeScript errors
  - Capture current build output as baseline

  **Must NOT do**:
  - Modify any files
  - Install any packages

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single verification command, no code changes
  - **Skills**: []
    - No specialized skills needed for a build check

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (solo — must complete before page work begins)
  - **Blocks**: Tasks 2, 3, 4, 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/landing/package.json` — find the build script/command for this app

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Verify baseline build succeeds
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run: pnpm --filter landing build (from project root)
      2. Assert: exit code is 0
      3. Capture: stdout/stderr output
    Expected Result: Build completes without errors
    Failure Indicators: Non-zero exit code, "Error" in output
    Evidence: Build output captured in terminal
  ```

  **Commit**: NO

---

- [ ] 2. Product Page — Add Miniature Component Graphics

  **What to do**:

  1. **Upgrade Hero** (lines 10-22): Replace the plain `bg-background` hero with an atmospheric dark hero matching the enterprise pattern. Add dark `bg-[#161820]` base, radial gradient blurs, subtle grid overlay, and horizon line — copy the exact atmospheric pattern from `hero.tsx:8-27`. Switch text colors to `#EDE8D0` cream palette for this section. Add 1-2 small floating glass-panel decorative elements (hidden on mobile with `hidden lg:block`) — e.g., a mini "task card" or "execute button" floating element.

  2. **Enhance Overview Section** (lines 34-57): The 3 existing `mock-card` cards (Task Board, Execution Engine, Pull Requests) already have card structure. Add a relevant Lucide icon to each card header (e.g., `LayoutDashboard` for Task Board, `Cpu` for Execution Engine, `GitPullRequest` for Pull Requests). Add a subtle mini-graphic inside each card — a 2-line mock list or a tiny status indicator — to give visual weight.

  3. **Replace Task Model Section** (lines 62-87): The current 5-item bullet list just describes task fields. Replace with a side-by-side layout: copy on the left, a `mock-card` on the right showing a miniature task card UI — with fields like "Title", "Status: In Progress", "Priority: High", a label pill, and a small PR link indicator. Use the `FeatureMock` pattern from `feature-sections.tsx:75-99` (window chrome dots, title bar, rows). Wrap the mock in `hidden lg:block` for mobile safety.

  4. **Replace Execution Engine Section** (lines 89-114): Replace the bullet list with copy on the left and a mock streaming terminal/log panel on the right. Build a `mock-card` styled component showing a fake terminal: a title bar with "Execution Log" label, and 4-5 rows with colored status indicators (green "✓ Cloned repository", yellow "⟳ Running agent...", etc.). This mimics the execution drawer from the real product.

  5. **Replace Batch System Section** (lines 116-145): Currently has text descriptions for parallel and queue modes in a 2-column grid. Add a `mock-card` below (or replace the text grid) showing a miniature "Batch Queue" panel — similar to the Execution Queue card in `hero.tsx:97-118` — with 3-4 task rows showing mixed statuses (Running, Queued, Completed, Merged).

  6. **Keep lighter sections simple**: GitHub Integration (lines 147-171), Desktop Architecture (lines 173-197), Supported Platforms (lines 199-223), and Roadmap (lines 225-249) can keep their existing structure — just ensure they don't feel redundant. If any section is nearly identical to another page's content, trim it or make the copy more specific.

  **Must NOT do**:
  - Don't extract shared components — keep all new graphics inline in this file
  - Don't add new CSS keyframes — reuse `animate-float-1` through `animate-float-5`
  - Don't convert to `"use client"` — keep as server component
  - Don't add npm dependencies

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI-heavy page redesign with visual component creation, CSS styling, layout work
  - **Skills**: [`frontend-design`]
    - `frontend-design`: Needed for crafting polished miniature UI graphics with proper spacing, color, and visual hierarchy

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 5)
  - **Blocks**: Task 6
  - **Blocked By**: Task 1

  **References**:

  **Pattern References** (existing code to follow):
  - `apps/landing/components/hero.tsx:8-27` — Atmospheric background pattern (dark bg, radial gradients, grid overlay, horizon line) — copy this for the product hero upgrade
  - `apps/landing/components/hero.tsx:62-163` — Floating glass-panel card positioning pattern (absolutely positioned cards within relative container, each with `animate-float-*` and `hidden lg:block`)
  - `apps/landing/components/feature-sections.tsx:75-99` — `FeatureMock` component pattern (window chrome dots, title bar, rows with label/detail) — recreate this pattern inline for task model and execution engine mocks
  - `apps/landing/components/hero.tsx:97-118` — Execution Queue card pattern (header bar with icon+title+count, divider rows with icon+name+status) — reuse for the batch system mock
  - `apps/landing/app/enterprise/page.tsx:10-22` — Enterprise hero atmospheric section pattern — the product hero should match this style

  **CSS Class References**:
  - `apps/landing/app/globals.css:164-190` — `.glass-panel` class definition (background, blur, borders, shadows, hover effects)
  - `apps/landing/app/globals.css:192-229` — `.mock-card` class definition (background, borders, shadows)
  - `apps/landing/app/globals.css:120-161` — `.glass-card` class (unused, available for use)
  - `apps/landing/app/globals.css:296-338` — `.animate-float-1` through `.animate-float-5` keyframe animations

  **Color References**:
  - `#EDE8D0` — Cream text color for atmospheric dark sections (see `hero.tsx:35,39`)
  - `#161820` — Dark atmospheric background color (see `hero.tsx:9`, `enterprise/page.tsx:11`)
  - `bg-background` / `bg-[#1a1c26]` — Standard alternating section backgrounds
  - `text-foreground`, `text-muted-foreground/65`, `text-primary/60` — Standard text colors for non-atmospheric sections

  **File to modify**:
  - `apps/landing/app/product/page.tsx` (currently 255 lines)

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Product page loads with new graphics at desktop viewport
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 1440x900
      2. Navigate to: http://localhost:3000/product
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: h1 text contains "A board that executes"
      5. Assert: At least 3 elements with class "mock-card" exist on the page
      6. Assert: At least 1 element with class "glass-panel" exists on the page
      7. Assert: No console errors
      8. Screenshot: .sisyphus/evidence/task-2-product-desktop.png
    Expected Result: Product page renders with mock UI graphics visible
    Evidence: .sisyphus/evidence/task-2-product-desktop.png

  Scenario: Product page hides decorative elements on mobile
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 375x812
      2. Navigate to: http://localhost:3000/product
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: No horizontal scrollbar (document.documentElement.scrollWidth <= window.innerWidth)
      5. Assert: Page is scrollable vertically
      6. Screenshot: .sisyphus/evidence/task-2-product-mobile.png
    Expected Result: Page renders cleanly on mobile without overflow
    Evidence: .sisyphus/evidence/task-2-product-mobile.png

  Scenario: Product page TypeScript compiles
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run lsp_diagnostics on apps/landing/app/product/page.tsx
      2. Assert: Zero errors
    Expected Result: No TypeScript errors
    Evidence: Diagnostics output
  ```

  **Commit**: YES
  - Message: `feat(landing): add miniature component graphics to product page`
  - Files: `apps/landing/app/product/page.tsx`

---

- [ ] 3. Enterprise Page — Add Visual Elements to Text Sections

  **What to do**:

  1. **Enhance Hero** (lines 10-22): Hero already has atmospheric background — good. Add 1-2 floating glass-panel elements (hidden on mobile with `hidden lg:block`). Suggestions: a mini "Container Status" card showing "Running | Isolated | Secure" states, or a mini shield/lock icon card. Position them in the right half of the hero using absolute positioning within a relative container, similar to `hero.tsx:60-165`.

  2. **Replace Local-First Architecture Bullets** (lines 24-47): Currently 4 plain bullets. Change to side-by-side: copy on left, a `mock-card` on the right showing a miniature architecture diagram — e.g., a card with "Architecture" title bar and rows like "Desktop App → Local API", "PostgreSQL → Local", "Docker → Isolated". Use the `FeatureMock` row pattern.

  3. **Replace Repository Isolation Bullets** (lines 49-72): Replace with a mock showing isolated worktrees. Build a `mock-card` showing 3 branch rows with status indicators — e.g., "feat/auth-flow — Isolated ✓", "fix/api-routes — Isolated ✓", "main — Protected". Similar to the Branches card in `hero.tsx:120-134`.

  4. **Replace Configurable Limits Bullets** (lines 74-97): Replace with a mock settings panel. Build a `mock-card` showing a "Settings" panel with rows like "Parallel Limit: 3", "Max Batch: 5", "Stop on Failure: Off", "Conflict: Skip" — mimicking the real settings UI.

  5. **Add Log Mock to Transparent Execution Logs** (lines 99-109): This section has only a heading + one paragraph and NO content. Add a `mock-card` showing a miniature streaming log panel — 4-5 colored log lines like "[info] Cloning repository...", "[agent] Creating branch feat/dark-mode", "[tool] Editing src/components/theme.tsx", "[success] PR #142 created". This is the most important addition on this page.

  6. **Simplify/Trim "Future: self-hosted"** (lines 111-121): This section is speculative and very sparse. Keep it but keep it minimal — just heading + paragraph is fine here. Don't add a graphic to a "maybe someday" section.

  **Must NOT do**:
  - Don't change the CTA section (lines 123-138) — it's already atmospheric and serves as a call to action
  - Don't extract shared components
  - Don't convert to `"use client"`

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI-heavy page redesign with visual component creation
  - **Skills**: [`frontend-design`]
    - `frontend-design`: Needed for crafting polished miniature UI graphics

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 4, 5)
  - **Blocks**: Task 6
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `apps/landing/components/hero.tsx:62-163` — Floating glass-panel positioning (absolute positioning, animation classes, `hidden lg:block`)
  - `apps/landing/components/hero.tsx:97-118` — Execution Queue card (header bar, divider rows with status)
  - `apps/landing/components/hero.tsx:120-134` — Branches card (icon, heading, pill-style branch names)
  - `apps/landing/components/feature-sections.tsx:75-99` — `FeatureMock` pattern (window chrome, title bar, row structure)
  - `apps/landing/app/enterprise/page.tsx:10-22` — Existing atmospheric hero (reference for keeping consistency)

  **CSS Class References**:
  - `apps/landing/app/globals.css:164-190` — `.glass-panel` (for floating hero elements)
  - `apps/landing/app/globals.css:192-229` — `.mock-card` (for section graphics)
  - `apps/landing/app/globals.css:296-338` — `.animate-float-*` animations

  **File to modify**:
  - `apps/landing/app/enterprise/page.tsx` (currently 144 lines)

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Enterprise page loads with new graphics at desktop viewport
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 1440x900
      2. Navigate to: http://localhost:3000/enterprise
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: h1 text contains "AI execution with control"
      5. Assert: At least 3 elements with class "mock-card" exist on the page
      6. Assert: No console errors
      7. Screenshot: .sisyphus/evidence/task-3-enterprise-desktop.png
    Expected Result: Enterprise page renders with mock UI graphics
    Evidence: .sisyphus/evidence/task-3-enterprise-desktop.png

  Scenario: Enterprise page hides decorative elements on mobile
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 375x812
      2. Navigate to: http://localhost:3000/enterprise
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: No horizontal scrollbar
      5. Screenshot: .sisyphus/evidence/task-3-enterprise-mobile.png
    Expected Result: Clean mobile render without overflow
    Evidence: .sisyphus/evidence/task-3-enterprise-mobile.png

  Scenario: Enterprise page TypeScript compiles
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run lsp_diagnostics on apps/landing/app/enterprise/page.tsx
      2. Assert: Zero errors
    Expected Result: No TypeScript errors
    Evidence: Diagnostics output
  ```

  **Commit**: YES
  - Message: `feat(landing): add miniature component graphics to enterprise page`
  - Files: `apps/landing/app/enterprise/page.tsx`

---

- [ ] 4. Pricing Page — Enhance Hero and Card Treatments

  **What to do**:

  1. **Upgrade Hero** (lines 10-22): Replace the plain `bg-background` hero with an atmospheric dark hero. Copy the atmospheric pattern from `hero.tsx:8-27` (dark `bg-[#161820]`, radial gradient blurs, grid overlay, horizon line). Switch text to `#EDE8D0` cream palette. Keep the "Simple pricing" headline and subhead. Add 1 small floating glass-panel element — e.g., a mini "$" or billing icon card with `hidden lg:block`.

  2. **Enhance Pricing Cards Section** (lines 24-98): The two pricing cards (Free / Pro) already use `mock-card` class and have reasonable structure. Enhancements:
     - Add Lucide icons next to each feature bullet (e.g., `FolderOpen` for "Single project", `Zap` for "Basic execution")
     - Add a subtle "Popular" or "Recommended" badge on the Pro card using a small pill element
     - Add a subtle visual divider or comparison indicator between the two cards
     - Do NOT restructure the cards — enhance them in place

  3. **Enhance Contact Footer Section** (lines 100-113): Currently just a single centered paragraph with an email link. Make it more substantial:
     - Add a slight atmospheric treatment or subtle glass-card background
     - Add a small decorative element — e.g., a `glass-panel` or `glass-card` floating element
     - Keep the email link prominent
     - Optionally add a "Questions?" heading above

  **Must NOT do**:
  - Don't restructure the Free/Pro card layout
  - Don't change pricing amounts ($0, $20)
  - Don't change feature lists on the cards

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Visual enhancement of existing page with CSS-heavy work
  - **Skills**: [`frontend-design`]
    - `frontend-design`: Needed for polished visual enhancements and card treatments

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 5)
  - **Blocks**: Task 6
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `apps/landing/components/hero.tsx:8-27` — Atmospheric background pattern for hero upgrade
  - `apps/landing/components/hero.tsx:62-78` — Small floating glass-panel card pattern
  - `apps/landing/app/pricing/page.tsx:28-95` — Existing pricing card structure (do not replace, only enhance)
  - `apps/landing/app/globals.css:120-161` — `.glass-card` class (unused, could work for the footer section enhancement)

  **File to modify**:
  - `apps/landing/app/pricing/page.tsx` (currently 119 lines)

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Pricing page loads with enhanced visuals at desktop viewport
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 1440x900
      2. Navigate to: http://localhost:3000/pricing
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: h1 text contains "Simple pricing"
      5. Assert: Text "$0" is visible on the page
      6. Assert: Text "$20" is visible on the page
      7. Assert: At least 2 elements with class "mock-card" exist (the pricing cards)
      8. Assert: No console errors
      9. Screenshot: .sisyphus/evidence/task-4-pricing-desktop.png
    Expected Result: Pricing page renders with enhanced visuals, prices intact
    Evidence: .sisyphus/evidence/task-4-pricing-desktop.png

  Scenario: Pricing page renders cleanly on mobile
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 375x812
      2. Navigate to: http://localhost:3000/pricing
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: No horizontal scrollbar
      5. Assert: Text "$0" is visible
      6. Assert: Text "$20" is visible
      7. Screenshot: .sisyphus/evidence/task-4-pricing-mobile.png
    Expected Result: Clean mobile layout, prices visible
    Evidence: .sisyphus/evidence/task-4-pricing-mobile.png

  Scenario: Pricing page TypeScript compiles
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run lsp_diagnostics on apps/landing/app/pricing/page.tsx
      2. Assert: Zero errors
    Expected Result: No TypeScript errors
    Evidence: Diagnostics output
  ```

  **Commit**: YES
  - Message: `feat(landing): enhance pricing page with atmospheric hero and card treatments`
  - Files: `apps/landing/app/pricing/page.tsx`

---

- [ ] 5. Contact Page — Add Atmospheric Hero and Decorative Elements

  **What to do**:

  1. **Upgrade Hero** (lines 22-34): Replace the plain `bg-background` hero with an atmospheric dark hero. Copy the atmospheric pattern from `hero.tsx:8-27`. Switch text to `#EDE8D0` cream palette. Keep "Get in touch" headline and subhead. This section stays as a simple text hero — no floating elements in the hero itself (the form section below provides the visual interest).

  2. **Enhance Form Section** (lines 36-127): The form section already has a dark `bg-[#1a1c26]` background and a 2-column grid (form left, contact info right). Enhancements:
     - Add 1-2 floating glass-panel decorative elements positioned around the form area (NOT inside the form JSX tree). Position them using absolute positioning within the section's relative container. Examples: a mini "Message sent ✓" confirmation card, or a "Response time: < 24h" info pill. All decorative elements must have `hidden lg:block`.
     - Add Lucide icons next to the Email and GitHub headings in the right column (e.g., `Mail` icon, `Github` icon)
     - Add subtle atmospheric touches: a radial gradient blur in the form section background for depth

  **CRITICAL**: This page is `"use client"` with `useState` hooks for form fields. 
  - Do NOT move or restructure the `<form>` element or its children (lines 40-101)
  - Do NOT add `useState` or new hooks
  - New decorative elements must be SIBLINGS of the form grid, not ancestors or children
  - The form's `onSubmit`, `value`, and `onChange` bindings must remain exactly as-is

  **Must NOT do**:
  - Don't modify form structure, state, or event handlers
  - Don't nest decorative elements inside the form
  - Don't add new `useState`/`useEffect` hooks
  - Don't change `"use client"` directive

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Visual enhancement with careful constraint around client component form
  - **Skills**: [`frontend-design`]
    - `frontend-design`: Needed for polished decorative elements while respecting form constraints

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 4)
  - **Blocks**: Task 6
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `apps/landing/components/hero.tsx:8-27` — Atmospheric background pattern for hero upgrade
  - `apps/landing/components/hero.tsx:62-78` — Floating glass-panel card positioning pattern
  - `apps/landing/app/contact/page.tsx:14-16` — Form state management (DO NOT TOUCH)
  - `apps/landing/app/contact/page.tsx:40-101` — Form JSX (DO NOT RESTRUCTURE — decorative elements go outside this tree)

  **CSS Class References**:
  - `apps/landing/app/globals.css:164-190` — `.glass-panel` for floating decorative elements
  - `apps/landing/app/globals.css:296-338` — `.animate-float-*` animations

  **File to modify**:
  - `apps/landing/app/contact/page.tsx` (currently 133 lines)

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Contact page loads with enhanced visuals at desktop viewport
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 1440x900
      2. Navigate to: http://localhost:3000/contact
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: h1 text contains "Get in touch"
      5. Assert: input[name="email"] exists and is interactable
      6. Assert: input[name="name"] exists and is interactable
      7. Assert: textarea#message exists and is interactable
      8. Assert: button[type="submit"] exists with text "Send message"
      9. Assert: No console errors
      10. Screenshot: .sisyphus/evidence/task-5-contact-desktop.png
    Expected Result: Contact page renders with atmospheric hero, form fully functional
    Evidence: .sisyphus/evidence/task-5-contact-desktop.png

  Scenario: Contact form is interactive after redesign
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Navigate to: http://localhost:3000/contact
      2. Fill: input#name with "Test User"
      3. Fill: input#email with "test@example.com"
      4. Fill: input#company with "Test Corp"
      5. Fill: textarea#message with "This is a test message"
      6. Assert: All fields contain the typed values
      7. Click: button[type="submit"]
      8. Assert: No error, page does not navigate away (form handler is preventDefault)
      9. Screenshot: .sisyphus/evidence/task-5-contact-form-test.png
    Expected Result: Form accepts input and submit doesn't crash
    Evidence: .sisyphus/evidence/task-5-contact-form-test.png

  Scenario: Contact page hides decorative elements on mobile
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 375x812
      2. Navigate to: http://localhost:3000/contact
      3. Wait for: h1 visible (timeout: 10s)
      4. Assert: No horizontal scrollbar
      5. Assert: Form fields still visible and accessible
      6. Screenshot: .sisyphus/evidence/task-5-contact-mobile.png
    Expected Result: Clean mobile render, form usable
    Evidence: .sisyphus/evidence/task-5-contact-mobile.png

  Scenario: Contact page TypeScript compiles
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run lsp_diagnostics on apps/landing/app/contact/page.tsx
      2. Assert: Zero errors
    Expected Result: No TypeScript errors
    Evidence: Diagnostics output
  ```

  **Commit**: YES
  - Message: `feat(landing): add atmospheric hero and decorative elements to contact page`
  - Files: `apps/landing/app/contact/page.tsx`

---

- [ ] 6. Final Build Verification + Cross-Page Visual QA

  **What to do**:
  - Run full build: `pnpm --filter landing build` — must pass
  - Run Playwright visual sweep across all 4 modified pages at 1440px viewport
  - Verify main page (`/`) is completely unchanged
  - Take comparison screenshots of all pages

  **Must NOT do**:
  - Don't modify any files
  - Don't fix issues — report them for the relevant task to fix

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Verification-only task, no code changes
  - **Skills**: [`playwright`]
    - `playwright`: Needed for browser-based visual verification across all pages

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (solo — final verification)
  - **Blocks**: None
  - **Blocked By**: Tasks 2, 3, 4, 5

  **References**:

  **File References**:
  - `apps/landing/app/page.tsx` — Main page (verify unchanged)
  - `apps/landing/app/product/page.tsx` — Modified in Task 2
  - `apps/landing/app/enterprise/page.tsx` — Modified in Task 3
  - `apps/landing/app/pricing/page.tsx` — Modified in Task 4
  - `apps/landing/app/contact/page.tsx` — Modified in Task 5

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Full build passes after all modifications
    Tool: Bash
    Preconditions: All page modifications completed (Tasks 2-5)
    Steps:
      1. Run: pnpm --filter landing build
      2. Assert: exit code is 0
    Expected Result: Build succeeds
    Evidence: Build output

  Scenario: All 4 modified pages load without errors
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Set viewport to 1440x900
      2. Navigate to /product — Assert: loads, no console errors, has mock-card elements
      3. Screenshot: .sisyphus/evidence/task-6-product-final.png
      4. Navigate to /enterprise — Assert: loads, no console errors, has mock-card elements
      5. Screenshot: .sisyphus/evidence/task-6-enterprise-final.png
      6. Navigate to /pricing — Assert: loads, no console errors, "$0" and "$20" visible
      7. Screenshot: .sisyphus/evidence/task-6-pricing-final.png
      8. Navigate to /contact — Assert: loads, no console errors, form fields present
      9. Screenshot: .sisyphus/evidence/task-6-contact-final.png
    Expected Result: All pages render correctly with new graphics
    Evidence: .sisyphus/evidence/task-6-*.png

  Scenario: Main landing page is unchanged
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Navigate to: http://localhost:3000/
      2. Assert: h1 text contains "Execute your tasks"
      3. Assert: Elements with class "glass-panel" exist (hero cards)
      4. Assert: No console errors
      5. Screenshot: .sisyphus/evidence/task-6-main-unchanged.png
    Expected Result: Main page is identical to before
    Evidence: .sisyphus/evidence/task-6-main-unchanged.png
  ```

  **Commit**: NO

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 2 | `feat(landing): add miniature component graphics to product page` | `apps/landing/app/product/page.tsx` | lsp_diagnostics |
| 3 | `feat(landing): add miniature component graphics to enterprise page` | `apps/landing/app/enterprise/page.tsx` | lsp_diagnostics |
| 4 | `feat(landing): enhance pricing page with atmospheric hero and card treatments` | `apps/landing/app/pricing/page.tsx` | lsp_diagnostics |
| 5 | `feat(landing): add atmospheric hero and decorative elements to contact page` | `apps/landing/app/contact/page.tsx` | lsp_diagnostics |

---

## Success Criteria

### Verification Commands
```bash
pnpm --filter landing build  # Expected: exit 0, no errors
```

### Final Checklist
- [ ] All 4 secondary pages have at least 2 miniature component graphics each
- [ ] All new decorative elements use `hidden lg:block` for mobile safety
- [ ] All pages use existing CSS classes (`glass-panel`, `mock-card`, `glass-card`, `animate-float-*`)
- [ ] No new CSS keyframes added
- [ ] No new npm dependencies added
- [ ] No new shared component files created
- [ ] Contact form still functions (fields present, interactive, submittable)
- [ ] Main page (`/`) is completely unchanged
- [ ] Build passes
- [ ] No TypeScript errors
- [ ] No console errors on any page
