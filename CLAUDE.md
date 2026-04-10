# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SillyTavern-Timelines is a SillyTavern extension that visualizes chat histories as an interactive timeline/graph. It displays all chats with a character as nodes connected in a directed acyclic graph (DAG), allowing users to explore branches, swipes, and checkpoints in their chat history. Think of it as a "Loom" interface built on SillyTavern's chat paradigm.

## Development Setup

**No build tool required** - This extension ships as raw ES modules loaded dynamically by SillyTavern. However, you need SillyTavern installed to test locally.

### Installation
1. Clone this repo into your SillyTavern `extensions` directory
2. Restart SillyTavern
3. The extension will load automatically (loading order 9)

### Testing
- Open SillyTavern and navigate to *Extensions > Timelines*
- Click *View Timeline* to see the graph interface
- Use `/tl` slash command to quickly open the timeline view
- Use `/tl r` to manually refresh the timeline data

### Development Workflow

1. **Testing changes**: Edit `.js` or `.css` files, then refresh the browser
2. **No compilation needed** - All source files are executed directly
3. **Settings persistence**: Use browser DevTools console to inspect/debug `extension_settings.timeline`
4. **API inspection**: Use browser DevTools Network tab to see SillyTavern API calls

## Architecture Overview

### Core Data Flow

```
SillyTavern API
    ↓
fetchData() [tl_node_data.js]
    ↓
prepareData() [tl_node_data.js]
    ↓
buildGraph() [tl_node_data.js] - DAG construction with deduplication
    ↓
renderCytoscapeDiagram() [index.js] - Graph visualization
    ↓
setupEventHandlers() [index.js] - Interactive features
```

### File Structure & Responsibilities

| File | Size | Purpose |
|------|------|---------|
| **index.js** | 82KB | Main orchestration: UI initialization, event binding, Cytoscape setup, state management |
| **tl_node_data.js** | 21KB | Core graph building: data fetching from API, DAG construction, message deduplication, node/edge creation |
| **tl_style.js** | 13KB | Visual styling: applies Cytoscape styles, checkpoint highlighting, color management |
| **tl_graph.js** | 7.7KB | Graph utilities: layout orientation, search highlighting, query parsing |
| **tl_utils.js** | 14KB | Navigation & interaction: message routing, branch creation, swipe handling |
| **timeline.html** | 18KB | UI templates: settings panel, modals, buttons, legends |
| **tl_style.css** | 6KB | Styling: modals, graph container, buttons, legends |

### Key Components

**Data Fetching** (`tl_node_data.js`):
- `fetchData()` - Gets chat list from `/api/characters/chats`
- `prepareData()` - Loads individual chat histories
- Uses SillyTavern API endpoints

**Graph Building** (`tl_node_data.js`):
- `buildGraph()` - Main algorithm: creates DAG from chats, deduplicates identical messages at same depth
- `createNode()` - Factory for node objects with metadata (text, depth, checkpoints, swipes)
- Handles checkpoint link following for colored paths
- Swipe nodes created for alternate responses

**Graph Rendering** (`index.js`):
- `renderCytoscapeDiagram()` - Entry point: orchestrates full render cycle
- `initializeCytoscape()` - Creates Cytoscape.js instance with Dagre layout
- `setupStylesAndData()` - Applies visual styling, builds color scheme
- `setupEventHandlers()` - Binds all interaction logic

**Layout** (`index.js`):
- Uses Cytoscape Dagre plugin for hierarchical DAG layout
- Configurable: direction (LR/TB), node spacing, ranking algorithm
- Settings-driven: adjustable via UI sliders and toggles

**Styling** (`tl_style.js`):
- Cytoscape style selectors for nodes, edges, highlights
- Theme support: UI theme colors or custom theme
- Checkpoint highlighting with deterministic hash-based colors
- Dynamic thickness/zIndex for path visualization

**Navigation** (`tl_utils.js`):
- `navigateToMessage()` - Jump to message in specific chat
- `createBranchFromNode()` - Create new chat branch at message
- Handles swipe navigation: creates branch for non-last-message swipes

**Graph Manipulation** (`tl_graph.js`):
- `toggleOrientation()` - Switch between TB and LR layouts
- `highlightSearchResults()` - Fragment-based filtering with visual highlighting
- Fragment search: whitespace-delimited AND logic (order-agnostic)

### State Management

**Persistent Settings** (stored in `extension_settings.timeline`):
- Layout parameters: `nodeWidth`, `nodeHeight`, `nodeSeparation`, `edgeSeparation`, `rankSeparation`, `spacingFactor`
- Display options: `nodeShape`, `curveStyle`, `nodeRanker`, `align`, `showLegend`, `autoExpandSwipes`
- Zoom control: `minZoom`, `maxZoom`, `enableMinZoom`, `enableMaxZoom`
- Colors: `useChatColors`, `bookmarkColor`, `charNodeColor`, `userNodeColor`, `edgeColor`
- Total: 23 configurable settings

**Runtime State** (in-memory):
- `lastContext` - Current character/group ID to detect context switches
- `lastTimelineData` - Cached processed graph data (nodes/edges)
- `theCy` - Cytoscape instance reference

**Cache Invalidation**:
- Triggered by character change (context switch)
- Also triggered by: chat deletion, new messages, message swipes
- Detected via `updateTimelineDataIfNeeded()` context comparison

### Integration with SillyTavern

**Extension Loading**:
- Loaded via `manifest.json` metadata
- Main entry: `index.js` (CSS: `tl_style.css`)
- Loading order: 9 (relatively late in extension load sequence)

**API Endpoints Used**:
- `GET /api/characters/chats` - List of chats for current character
- `GET /api/chats/get` - Individual chat messages
- `GET /api/chats/group/get` - Group chat messages
- `POST /api/characters/chats` - Create branches

**Event Hooks Listened**:
- `CHARACTER_MESSAGE_RENDERED` - Invalidate cache on new AI message
- `USER_MESSAGE_RENDERED` - Invalidate cache on new user message
- `CHAT_DELETED` - Invalidate cache on chat deletion
- `MESSAGE_SWIPED` - Invalidate cache on swipe change

**UI Integration**:
- Settings panel: *Extensions > Timelines*
- Slash commands: `/tl` (open), `/tl r` (refresh)
- Modal overlay: displays graph on full screen with close button
- Tooltips: use Tippy.js for popups

## Graph Building Algorithm

The core algorithm in `buildGraph()` creates a DAG from multiple chat histories:

1. **Transpose chats by message index** - Organize messages at each depth level
2. **Create root node** - Single node representing all AI characters
3. **Iterate through message indices**:
   - Group messages by exact text content (deduplication)
   - For each unique message:
     - Create node with metadata (depth, sessions it appears in, swipes)
     - Handle swipes (alternate responses at same depth)
     - Create edge from previous message/root
4. **Follow checkpoint links** - Color checkpoint paths with hash-based deterministic colors
5. **Return Cytoscape elements** - Array of `{group, data}` objects ready for rendering

**Key property: Messages with identical content at the same depth merge into single node**, ensuring DAG structure (no cycles) while allowing exploration of parallel chat branches.

## Notable Design Decisions

1. **No build tool** - Simplicity: ships as raw ES modules for direct browser loading
2. **Cytoscape.js + Dagre** - Mature, feature-rich graph library vs lighter alternatives
3. **Message equality** - Exact text matching (case-sensitive, whitespace matters)
4. **Deterministic colors** - Hash-based checkpoint colors ensure reproducibility
5. **Single modal overlay** - Timeline view temporarily replaces main ST UI
6. **Fragment search (Swoop)** - Whitespace-delimited AND logic inspired by Emacs Helm
7. **Lazy swipe rendering** - Swipe nodes added/removed on demand for performance
8. **Settings debouncing** - Prevents excessive saves during slider input

## External Libraries

- **Cytoscape.js** (361KB) - Core graph visualization engine
- **Cytoscape Dagre plugin** - Hierarchical DAG layout algorithm
- **Dagre** (323KB) - Graph layout calculations
- **Tippy.js** - Tooltip/popup positioning
- **Cytoscape Context Menus** - Right-click menu support
- **Cytoscape Popper** - Popper.js integration for positioning

## Automated Tests

Tests use [Vitest](https://vitest.dev/) and run entirely in Node without SillyTavern installed.

### Running tests

```bash
npm test                # run all tests once
npm run test:watch      # re-run on file save
npm run test:coverage   # run with coverage report
npm run test:bench      # run performance benchmarks
```

> **NixOS note**: if `node` isn't on PATH, use the full binary path:
> `/nix/store/.../bin/node node_modules/.bin/vitest run`

### Test structure

```
test/
├── fixtures/           # JSON chat histories used as test inputs
│   ├── schema.js       # validateFixture() / assertValidFixture()
│   ├── empty.json      # edge case: no messages
│   ├── single-message.json
│   ├── dead-bookmark.json
│   ├── newline-normalization.json
│   ├── simple-branching.json   # generated
│   ├── deep-conversation.json  # generated
│   ├── checkpoint-tree.json    # generated
│   ├── swipe-heavy.json        # generated
│   ├── multi-character.json    # generated
│   └── complex-tree.json       # generated
├── stubs/              # minimal no-op shims for SillyTavern imports
├── unit/               # pure-function tests (sfc32, buildGraph, highlight, …)
├── parity/             # server vs. client produce identical graph output
├── integration/        # full convertToCytoscapeElements pipeline
├── fallback/           # prepareData: server path, 404 fallback, network error
├── bench/              # vitest bench for buildGraph / layout performance
└── generate-fixtures.js  # regenerate AI-generated fixtures (needs API key)
```

### How SillyTavern imports are shimmed

The extension imports from relative paths like `../../../../script.js` (assumes installation inside SillyTavern). `vitest.config.js` aliases those exact import strings to stub files under `test/stubs/`, so no SillyTavern installation is needed.

### Private function access

Graph-building functions are module-private. Each relevant file exposes a `_testExports` object (not part of the public API):

```js
import { _testExports as server } from './server-plugin/index.js';
import { _testExports as client } from './tl_node_data.js';
import { _testExports as clientStyle } from './tl_style.js';
```

### Adding new tests

- **New fixture**: add a `.json` file to `test/fixtures/`. Run `assertValidFixture()` from `schema.js` on it. Follow the format `{ "filename.jsonl": [...messages] }` where each message has at minimum `name`, `is_user`, `mes`, `send_date`.
- **Regenerating AI fixtures**: `ANTHROPIC_API_KEY=... node test/generate-fixtures.js` — uses Claude Haiku with structured output to generate realistic conversation trees.
- **New unit test**: import `_testExports` from the file under test. Use `buildFromFixture(impl, fixture)` helpers where possible to keep both server and client covered.
- **Parity test**: use `normalizeElements()` (dedup by ID, strip positions) to compare server vs. client output.

### Testing Checklist

When making changes:

- [ ] `npm test` passes with no failures
- [ ] Changes don't break existing chat visualization (manual browser test)
- [ ] Node clicking opens info panel with correct message text
- [ ] Double-click navigates to message correctly
- [ ] Search filtering works with fragment queries (space-separated terms)
- [ ] Checkpoint highlighting displays with correct colors
- [ ] Layout orientation toggle (TB/LR) works smoothly
- [ ] Swipe nodes expand/collapse on long-press
- [ ] Settings changes persist across page reload
- [ ] Graph handles large chat histories (50+ messages per chat)
- [ ] No console errors during normal usage

## Common Debugging Tasks

**Inspecting rendered graph**:
```javascript
// In browser console:
console.log(window.theCy.elements()); // All nodes/edges
console.log(window.extension_settings.timeline); // Current settings
```

**Cache issues**:
- Graph not updating? Check: `lastContext` changed, cache invalidation triggered
- Manual refresh: `/tl r` slash command or refresh button in timeline view

**Layout issues**:
- Nodes overlapping? Adjust `spacingFactor`, `nodeSeparation` in settings
- Labels cut off? Increase `nodeWidth`, `nodeHeight`

**Style debugging**:
- Open browser DevTools Inspector, select graph element
- Check applied Cytoscape styles in console: `theCy.style().toString()`

## Performance Considerations

- **Rendering**: DAG layout with Dagre is O(nodes + edges). Slows noticeably with 100+ unique messages
- **Memory**: Entire chat history loaded into memory via API
- **Search**: Fragment search is linear scan but efficient for typical chat sizes (under 1000 messages)
- **Caching**: Invalidation on character change, not per-message updates

## Extension Metadata

- **Display name**: Timelines
- **Version**: 1.2.0
- **Author**: city-unit
- **License**: MIT
- **Homepage**: https://github.com/SillyTavern/SillyTavern-Timelines
- **Auto-update**: Enabled
