# Nova UI/UX refactor: issue register

Baseline (master `44fb0a5`): `npm run check` clean, `npm test` 403/403, `npm run test:browser` 19/19. Baseline screenshots
(3 widths x 2 themes x 6 states) were captured against a mocked API and are not committed (6 MB).

| ID | Issue | Component | Severity | Proposed fix | Validation | Phase |
|----|-------|-----------|----------|--------------|------------|-------|
| U1 | Hero card is hard-coded ("Live sample", 82, "Apply with a plan") and contradicts the real result for the same sample | `.sample-decision` | Critical | Label as illustrative, drop the live dot, explain | browser test | 1 (done) |
| U2 | Report title, context row show generic stand-ins ("Eligibility assessment", "Candidate profile") until details arrive, then change identity | `renderInsightPanels` | Critical | `reportHeader()` with loading / failed states | unit + browser | 1 (done) |
| U3 | Seven modules say "Preparing…" with no explanation; failure only discoverable inside a dialog | modules, banner | High | Banner for loading and failure with retry | browser | 1 (done) |
| U4 | Cancel race: an aborted run's `finally` could tear down a newer run | `runAnalysis` | Low | Compare controller before cleanup | browser (guards behaviour) | 1 (done) |
| U5 | 111 text nodes <= 12px (52 at 10-11px), mostly DM Mono in `--faint` | global type | Critical | Raise floor, adjust tokens | contrast script | 2 (done) |
| U6 | Headline stats and module summaries truncate with ellipsis | `.decision-stats`, `.analysis-module`, `.report-context` | High | Wrap | screenshots | 2 (done) |
| U7 | Evidence dialog opens with a dense scoring block; nested scrollbars | `moduleContent('requirements')` | High | "How this is scored" disclosure | unit + browser | 2 (done) |
| U8 | Three sample controls; two "See a sample decision" buttons | hero, workspace | Medium | Consolidate | journey test | 3 (done) |
| U9 | No navigation for Profile / Reports / Resources | header | High | Anchor navigation to existing sections | journey test | 3 (done) |
| U10 | Textareas ~3 lines tall; stacked rules | `.input-card` | High | Taller fields, fewer borders | screenshots | 4 (done) |
| U11 | Constellation lines cross text on the hero card | canvas | Medium | Quiet zones over text, lower opacity and density, paused off-screen; card no longer moves | screenshots + browser | 6 (done) |
| U12 | Mobile toolbar wraps, icon-only buttons unlabeled, history remove buttons overflow by 3px | `.report-actions`, history | High | Labelled 2-column action grid, 44px targets, nav keeps current item in view | 5-width browser tests | 7 (done) |
| U13 | Accessibility not yet audited (keyboard, focus, dialog, contrast) | all | Critical | Audit and fix | axe where available | 8 (done, see ACCESSIBILITY.md) |
