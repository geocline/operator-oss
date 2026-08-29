# Mobile Question Panel Scrolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pending question panels and focused chat usable and vertically scrollable on iPhone.

**Architecture:** Keep the transcript and question composer as sibling flex regions. Split `AskPanel` into fixed header/actions and a bounded scrolling question body, then apply the height and overflow constraints only at the mobile breakpoint. Preserve the existing answer state and submission flow.

**Tech Stack:** React, TypeScript, CSS, Vitest, react-test-renderer

---

### Task 1: Add the mobile scrolling regression

**Files:**
- Modify: `tests/composerTakeover.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that reads `app/globals.css` and `app/orchestrator/Transcript.tsx`,
asserting that `AskPanel` renders an `.ask-panel-body` around its questions and
that mobile CSS bounds the panel, enables vertical scrolling in its body, and
keeps the header and footer from shrinking.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/composerTakeover.test.ts`

Expected: FAIL because `.ask-panel-body` and the mobile constraints do not exist.

### Task 2: Implement bounded question scrolling

**Files:**
- Modify: `app/orchestrator/Transcript.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Add the scroll-body wrapper**

Wrap the existing mapped question elements in:

```tsx
<div className="ask-panel-body">
  {questions.map(/* existing question rendering */)}
</div>
```

- [ ] **Step 2: Add the minimal mobile layout rules**

Inside `@media (max-width:760px)`, make `.ask-panel` a bounded flex column with
`max-height` based on the dynamic viewport, give `.ask-panel-body` `min-height:0`
and `overflow-y:auto`, enable momentum scrolling, and keep the header/footer
from shrinking. Ensure `.sess-main` remains height-constrained and scrollable
in focused mobile sessions.

- [ ] **Step 3: Run the focused tests**

Run: `npm test -- tests/composerTakeover.test.ts tests/sessionPaneSuppressions.test.ts`

Expected: both test files pass.

- [ ] **Step 4: Run project verification**

Run: `npm run verify`

Expected: typecheck, lint, and tests complete with exit code 0.
