# Nova accessibility audit (Phase 8)

This records what was tested, what was found, and what was not tested. It is not a conformance claim: automated scanners
catch a minority of WCAG issues, and no assistive technology was run.

## Tested

| Check | How | Result |
|-------|-----|--------|
| Automated WCAG 2.0/2.1/2.2 A and AA rules plus axe best practices | axe-core 4.x, run in Chromium on landing, workspace, report and evidence dialog, in dark and light themes, at 375 and 1440px (16 scans) | 0 violations after the fixes below |
| Keyboard: skip link, Tab order, visible focus | Playwright tests (`test-browser/a11y.browser.js`) | Pass |
| Dialog focus: moves in, stays in, returns to the opener on Escape | Playwright | Pass (native `<dialog>` modal) |
| Live announcements | Playwright asserts `#liveStatus` (polite) and `role="status"` field messages carry text | Pass |
| Accessible names for every visible control | Playwright | Pass |
| Heading structure | Playwright: one visible h1 per screen, no skipped levels | Pass after fix |
| Contrast of text tokens and status tags | `test/readability.test.js` computes ratios from the CSS tokens | Pass after fix |
| Touch targets | Playwright at 375px: every visible button, link, summary and select is at least 44px tall | Pass |
| Reflow | No horizontal page scroll from 320px to 1440px | Pass |
| Reduced motion | Constellation and sample card hold still, scripted scrolling is instant | Pass |

## Found and fixed

1. **No h1 in the report view** (axe `page-has-heading-one`): the report title was an h2 and the hero h1 is hidden in report mode. The title is now the h1, and the report's section headings moved from h3 to h2 so levels do not skip.
2. **Brand link name did not contain its visible text** (axe `label-content-name-mismatch`): the two spans had no space between them ("NovaAI"). A space was added, so "Nova AI home" contains "Nova AI".
3. **Warning tag contrast in the light theme** was 4.37:1 (needs 4.5:1). `--warning` went from `#8a5e26` to `#835821` (4.79:1). It is a small darkening within the existing hue.
4. **Text-field boundary was about 1.3:1** against its surroundings. It now meets 3:1 (see Not tested, below, for the other hairlines).
5. **Fit score** had `aria-label` on a `<strong>` with no role, which ARIA prohibits (axe flagged it as needing review). It now has `role="img"` and reads "Fit score 62 out of 100", so a screen reader does not hear the number counting up.

## Not tested, or known limits

- **No screen reader was run** (NVDA, JAWS, VoiceOver, TalkBack). Announcement behaviour is asserted from the DOM, not heard.
- **Hairline borders** (`--line`, about 1.3:1) are a deliberate part of Nova's look. They separate regions and outline buttons that also carry a text label, so they are not the only cue for anything, with one exception: the two text fields. A field's boundary has to reach 3:1 (WCAG 1.4.11), so the textareas now use `--field-edge` (ink at 40% in dark, 52% in light: 3.5:1 and about 3.3:1 against the page and the field). Unit tests assert this from the CSS tokens.
- axe left three checks as "needs review": text over the hero constellation canvas (background cannot be computed; the canvas draws faintly there by design), the skip link target, and the score label (since fixed). Hero text contrast was checked by token ratios, not by sampling rendered pixels.
- Windows High Contrast / forced-colors mode, 200% browser zoom and text-spacing overrides were not tested.
- Browsers: Chromium only.
