# History Layout Containment Design

## Goal

Prevent long session cards in the History screen from crossing the left grid column and covering the detail panel at desktop widths such as 1244×910.

## Cause

The two-column grid gives the session list a bounded track, but the list and its children retain their intrinsic minimum width. Long single-line titles therefore overflow the grid track even though the detail column itself is sized correctly.

## Considered approaches

1. Constrain the existing grid children with `min-width: 0`, width limits, and text truncation. This is the approved approach because it fixes containment without changing the screen structure.
2. Make the left column wider. Rejected because it only moves the collision to another window size.
3. Move details below the list or into a modal. Rejected as an unnecessary navigation redesign.

## Layout behavior

- Keep the existing two-column desktop layout.
- Allow the session-list grid item and every card to shrink inside the assigned track.
- Clip card contents at the card boundary and truncate long titles with an ellipsis.
- Preserve the existing responsive breakpoint that stacks the list and details on narrower windows.
- Do not introduce horizontal page scrolling.

## Tests and verification

- Add a focused CSS regression test that checks the containment contract on the history list, card, and title selectors.
- Run the desktop test and build suites.
- Visually verify the History screen at 1244×910 with long Russian/English vacancy names: cards stay entirely left of the detail panel and both columns remain readable.

## Success criteria

- No session card paints over the detail panel.
- Long titles truncate inside the left card.
- Existing selection, scrolling, and responsive stacking continue to work.
