# TrackerControl iOS design preview

This dependency-free preview contains a homepage and one detailed example report for Wordle!. It uses static example data only: there is no live app search, service integration, or report queue.

Open `index.html` directly in a browser. For HTTP review, serve the `docs/design/` directory with any static server scoped to that directory; the parent preview server uses `http://localhost:4318/` in this session.

The preview was checked with `node --check docs/design/preview.js`. Only Wordle! has a local detailed report; Merge Dragons! and Subway Surfers are clearly labelled example entries.
