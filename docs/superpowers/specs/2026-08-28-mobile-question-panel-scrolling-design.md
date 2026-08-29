# Mobile Question Panel Scrolling Design

## Problem

On iPhone, an unanswered agent question replaces the normal composer with an
`AskPanel`. The application shell prevents body scrolling, the transcript owns
its own scroll container, and the question panel sits below that transcript as
a non-scrolling flex sibling. When several questions or options make the panel
taller than the remaining viewport, the panel's current `overflow: hidden`
clips its lower content. The user cannot reach every option or the answer
controls by scrolling.

The same constraint can leave focus mode feeling smaller than expected on a
phone because the mobile session header continues to consume multiple rows.

## Approved Behavior

### Normal mobile session

- Keep the transcript and question panel as separate vertical regions.
- Constrain the question panel to the space available inside the session pane.
- Make the question panel's question-and-option content vertically scrollable.
- Keep the panel heading and action area reachable while the middle content
  scrolls.
- Preserve normal transcript scrolling above the question panel.
- Respect iPhone safe-area insets and avoid covering the bottom actions.

### Mobile focus mode

- Collapse the session chrome to the existing slim focus header.
- Give the chat/session body the remaining viewport height.
- Keep the transcript scrollable.
- Apply the same bounded, scrollable question-panel behavior when an agent is
  waiting for input.

### Desktop

- Preserve the current desktop layout and interaction.
- Scope the new sizing and scrolling behavior to the existing mobile breakpoint
  wherever possible.

## Component Boundaries

- `SessionView` continues to decide whether the normal `Composer` or `AskPanel`
  is rendered.
- `AskPanel` continues to own question selection and answer submission.
- Layout CSS owns the height constraint, internal scrolling, and sticky/reachable
  panel regions. No answer-state or API behavior changes are needed.
- Existing focus-mode state continues to control the header; the fix only makes
  the mobile focused layout consume the viewport correctly.

## Interaction Details

- A vertical swipe beginning over the question choices scrolls the question
  choices.
- A vertical swipe beginning in the transcript scrolls the transcript.
- The question panel does not expand beyond the session body.
- Long question sets remain usable without switching to focus mode.
- Focus mode provides a full-height chat workspace, with only the slim focus
  header outside the scrollable session body.
- Opening the iOS keyboard for an `Other` answer must not permanently trap or
  cover the panel actions after the viewport resizes.

## Accessibility

- Preserve current button and input semantics.
- Keep touch targets at the existing mobile-friendly size.
- Do not rely on a hidden scrollbar as the only indication that more content
  exists; clipped content at the panel edge should make continued scrolling
  visually natural.
- Preserve keyboard focus visibility and allow the focused input or button to
  be scrolled into view.

## Testing

Add a regression test that proves the mobile CSS:

- bounds the pending question panel within the session's available height;
- creates a vertical scrolling region for questions and options;
- keeps the question panel's actions reachable;
- leaves desktop rules unchanged; and
- retains full-height, scrollable session behavior in mobile focus mode.

Run the focused regression test, the existing composer-takeover tests, the
relevant session/focus UI tests, and the project's full verification command.
Also inspect the rendered result at an iPhone-sized viewport with enough
questions to exceed the available height.

## Out of Scope

- Replacing questions with a modal or full-screen sheet.
- Combining transcript and question content into one page-level scroll region.
- Changing agent question data, answer submission, or task state.
- Redesigning desktop session controls.
