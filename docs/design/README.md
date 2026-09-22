# TrackerControl iOS design preview

This dependency-free preview contains a homepage and one detailed example report for Wordle!. It uses static example data only: there is no live app search, service integration, or report queue.

Open `index.html` directly in a browser. For HTTP review, serve the `docs/design/` directory with any static server scoped to that directory.

The mobile refinement retains the existing palette, typography and shared responsive pages. It reduces header and hero spacing on phones, keeps example reports ahead of research statistics, and adds a plain-language report introduction with expandable analysis metadata. Sample-only entries remain visibly labelled on mobile. The live homepage now uses only its main search form; other live pages keep the header search.

Browser checks covered 320px, 390px and 1280px widths without page-level horizontal overflow, app search, combined tracker filters and the metadata disclosure. Mobile form controls retain 16px text and at least 44px height. This is browser viewport validation, not a physical iPhone Safari test.

The preview was checked with `node --check docs/design/preview.js`. Only Wordle! has a local detailed report; Merge Dragons! and Subway Surfers are clearly labelled example entries.
