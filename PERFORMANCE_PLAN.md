# Performance Plan

This plan focuses on measurable wins with low correctness risk, based on current profiling data:

- `dagre.layout()` dominates total request time.
- File read + parse is the second major backend cost, but much smaller than layout.
- JSON serialization/compression is noticeable but secondary after layout.

The work is split into PR-sized chunks so each change is measurable and easy to revert.

## Baseline Before Starting

Use the same large real-world dataset for all comparisons and capture:

- Total request time (`[timelines-data] [perf] Total request time`)
- `File read + parse` time
- `computeLayout` and `dagre.layout()` time
- `JSON serialize + gzip` time
- Response size (compressed + uncompressed)

Run each scenario at least 5 times and compare median + p95.

## Status (Apr 2026)

### PR 1 (Completed)

Goal: remove obvious avoidable overhead and event-loop blocking with minimal behavior change.

Implemented:

1. Remove double layout run on rotate
   - Files: `index.js`, `tl_graph.js`
   - Current rotate path triggers `toggleGraphOrientation(...)` and then `refreshLayout()`, causing two layout runs.
   - Keep a single layout run per rotation.

2. Gate heavy perf diagnostics in `computeLayout`
   - File: `server-plugin/index.js`
   - The unique node/edge Set construction used only for logs should be behind a debug flag.
   - Keep high-level timings, avoid extra allocations by default.

3. Switch sync gzip to async gzip with speed-oriented level
   - File: `server-plugin/index.js`
   - Replace `gzipSync` with async `zlib.gzip`.
   - Use a tuned compression level (for example `1` to `4`) for CPU/latency reduction.

4. Respect `Accept-Encoding`
   - File: `server-plugin/index.js`
   - Only gzip when client accepts it; otherwise send plain JSON.

Observed impact (real dataset):

- Helped secondary costs (notably JSON+gzip).
- Did **not** materially reduce end-to-end request time because `dagre.layout()` still dominates.

Validation done:

- Tests pass.
- Rotate behavior is visually unchanged.
- Perf logs confirm one layout run per rotate action.

### PR 2 (Experimented, then simplified)

Goal was to reduce backend CPU + memory pressure during chat loading and layout setup.

Attempted items:

1. Concurrency-limited file read/parse
   - File: `server-plugin/index.js`
   - Replace unbounded `Promise.all(chatFiles.map(...))` with bounded concurrency (start with 8).
   - Keep exact output semantics.

2. Edge pair dedup before dagre graph insertion
   - File: `server-plugin/index.js`
   - Deduplicate `(source, target)` before `g.setEdge(...)` in `computeLayout`.
   - Avoid redundant graph operations.

3. Reduce parse allocations
   - File: `server-plugin/index.js`
   - Replace `lines.map(...).filter(...)` with a single loop parser.
   - Keep malformed-line behavior and logging semantics.

4. Cache hygiene improvements for encoding variants
   - File: `server-plugin/index.js`
   - Ensure compressed response reuse remains valid across encoding variants.

Outcome:

- Improvements were small/variable in end-to-end runs.
- The additional complexity around read/parse concurrency and custom parser was not justified by measured gains.
- Simpler bulk-read path (`Promise.all`) is preferred for now.
- Cache hygiene for mixed encoding variants is retained.

## Current Priority: PR 3 Layout Cache

Goal: reduce repeated `dagre.layout()` cost without correctness regressions.

### Scope

1. Layout position cache for interactive relayouts
   - Files: likely new `tl_layout_cache.js`, plus `index.js`, `tl_graph.js`
   - Cache key must include:
     - Graph structure (node IDs + edge pairs)
     - Layout settings (`rankDir`, `ranker`, separations, spacing, align, dimensions)
   - Do not override user-selected layout settings.

2. Cache invalidation strategy
   - Invalidate on settings changes, orientation change, swipe expansion changes, and data reload.

### Expected Impact

- Major interaction win for repeated relayout actions with unchanged graph.
- This is the only near-term item likely to significantly improve total perceived latency.

### Validation

- Visual parity checks for rotate/expand/reload workflows.
- Add regression tests for cache key correctness.
- Add perf logs for cache hit/miss and compare median + p95 on repeated actions.

## Measurement Notes

Keep using the same large real-world dataset and capture:

- Total request time (`[timelines-data] [perf] Total request time`)
- `File read + parse` time
- `computeLayout` and `dagre.layout()` time
- `JSON serialize + gzip` time
- Response size (compressed + uncompressed)

Run each scenario at least 5 times and compare median + p95.

## Deferred / Revisit Later

Possible future revisit only if needed:

- Concurrency-limited file read/parse
- Single-pass JSONL parser
- Additional pre-layout dedup micro-optimizations

## Deferred Work

Advanced and higher-risk ideas are tracked in `ADVANCED_IMPROVEMENTS.md`.
