/**
 * Parity tests: verify that the server and client graph-building pipelines
 * produce identical output for the same input.
 *
 * This is the most valuable test category since both paths MUST produce the same
 * graph structure — any divergence is a bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { _testExports as server } from '../../server-plugin/index.js';
import { _testExports as client } from '../../tl_node_data.js';
import { _testExports as clientStyle } from '../../tl_style.js';

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

// Normalize an element array to a stable comparison form:
// sort by id, strip fields that are expected to differ (positions, internal counters)
function normalizeElements(elements) {
    return elements
        .filter(e => !e.data.isSwipe) // swipe nodes are stored as metadata, skip them
        .map(e => ({
            group: e.group,
            id: e.data.id,
            ...(e.group === 'nodes' ? {
                msg: e.data.msg,
                chat_depth: e.data.chat_depth,
                isBookmark: e.data.isBookmark,
                bookmarkName: e.data.bookmarkName,
                is_user: e.data.is_user,
                is_system: e.data.is_system,
            } : {
                source: e.data.source,
                target: e.data.target,
            }),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

// When buildGraph produces duplicate edges (same source→target, different IDs),
// the server and client may highlight different edge IDs due to Map.set() vs Array.find()
// tie-breaking. Normalize by (source→target) so parity test is not sensitive to which
// specific duplicate edge gets highlighted.
function normalizeHighlighted(elements) {
    // Nodes: dedup by id, taking the first occurrence's borderColor
    const nodeMap = new Map();
    elements.filter(e => e.group === 'nodes' && !e.data.isSwipe).forEach(e => {
        if (!nodeMap.has(e.data.id)) {
            nodeMap.set(e.data.id, {
                group: 'nodes',
                id: e.data.id,
                borderColor: e.data.borderColor ?? null,
                color: e.data.color ?? null,
            });
        } else if (e.data.borderColor) {
            // If any duplicate has borderColor set, prefer it
            nodeMap.get(e.data.id).borderColor = e.data.borderColor;
        }
    });

    // Edges: dedup by source→target pair, any highlight on the pair counts
    const edgeMap = new Map();
    elements.filter(e => e.group === 'edges' && !e.data.isSwipe).forEach(e => {
        const key = `${e.data.source}→${e.data.target}`;
        const existing = edgeMap.get(key);
        if (!existing) {
            edgeMap.set(key, {
                group: 'edges',
                key,
                isHighlight: e.data.isHighlight ?? false,
                color: e.data.color ?? null,
            });
        } else if (e.data.isHighlight) {
            existing.isHighlight = true;
            existing.color = e.data.color ?? null;
        }
    });

    const nodes = [...nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const edges = [...edgeMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    return { nodes, edges };
}

function buildClientGraph(fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = client.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    return client.buildGraph(preprocessed, lengths);
}

function buildServerGraph(fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = server.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    return server.buildGraph(preprocessed, lengths);
}

function applyClientHighlighting(elements) {
    Object.values(elements).forEach(entry => {
        if (entry.group === 'nodes' && entry.data.isBookmark) {
            clientStyle.highlightPathToRoot(elements, entry.data.id);
        }
    });
    return elements;
}

const FIXTURES = [
    'simple-branching',
    'deep-conversation',
    'checkpoint-tree',
    'swipe-heavy',
    'multi-character',
    'complex-tree',
    'empty',
    'single-message',
    'newline-normalization',
];

describe('preprocessChatSessions parity', () => {
    for (const fixtureName of FIXTURES) {
        it(`${fixtureName}`, () => {
            const fixture = load(fixtureName);
            const serverResult = server.preprocessChatSessions(JSON.parse(JSON.stringify(fixture)));
            const clientResult = client.preprocessChatSessions(JSON.parse(JSON.stringify(fixture)));

            // Same number of depth levels
            expect(clientResult.length).toBe(serverResult.length);

            // Same structure at each depth
            serverResult.forEach((depth, i) => {
                expect(clientResult[i]).toHaveLength(depth.length);
                // Same file_names at each depth (order may differ, so sort)
                const serverFiles = depth.map(o => o.file_name).sort();
                const clientFiles = clientResult[i].map(o => o.file_name).sort();
                expect(clientFiles).toEqual(serverFiles);
            });
        });
    }
});

describe('buildGraph parity (pre-highlighting)', () => {
    for (const fixtureName of FIXTURES) {
        it(`${fixtureName}`, () => {
            const fixture = load(fixtureName);
            const serverElements = buildServerGraph(fixture);
            const clientElements = buildClientGraph(fixture);

            const serverNorm = normalizeElements(serverElements);
            const clientNorm = normalizeElements(clientElements);

            // Same number of nodes and edges
            expect(clientNorm.filter(e => e.group === 'nodes').length)
                .toBe(serverNorm.filter(e => e.group === 'nodes').length);
            expect(clientNorm.filter(e => e.group === 'edges').length)
                .toBe(serverNorm.filter(e => e.group === 'edges').length);

            // Same normalized structure
            expect(clientNorm).toEqual(serverNorm);
        });
    }
});

describe('highlighting parity', () => {
    // Only test fixtures that have checkpoints
    const checkpointFixtures = ['checkpoint-tree', 'complex-tree'];

    for (const fixtureName of checkpointFixtures) {
        it(`${fixtureName}: server and client produce same highlight state`, () => {
            const fixture = load(fixtureName);

            // Server: buildGraph + highlightCheckpointPaths
            const serverElements = buildServerGraph(fixture);
            server.highlightCheckpointPaths(serverElements);

            // Client: buildGraph + manual highlighting loop
            const clientElements = buildClientGraph(fixture);
            applyClientHighlighting(clientElements);

            const serverHighlights = normalizeHighlighted(serverElements);
            const clientHighlights = normalizeHighlighted(clientElements);

            expect(clientHighlights).toEqual(serverHighlights);
        });
    }

    it('no-checkpoint fixtures are unaffected by highlighting', () => {
        const fixture = load('simple-branching');

        const serverElements = buildServerGraph(fixture);
        server.highlightCheckpointPaths(serverElements);

        const clientElements = buildClientGraph(fixture);
        applyClientHighlighting(clientElements);

        // No element should have isHighlight=true
        const serverHighlighted = serverElements.filter(e => e.data.isHighlight);
        const clientHighlighted = clientElements.filter(e => e.data.isHighlight);
        expect(serverHighlighted).toHaveLength(0);
        expect(clientHighlighted).toHaveLength(0);
    });
});

describe('generateUniqueColor parity', () => {
    it('server and client produce identical colors for same string', () => {
        const testStrings = ['test', 'hello world', 'checkpoint', 'Branch #1', ''];
        for (const str of testStrings) {
            // Note: empty string uses Math.random so skip that
            if (!str) continue;
            expect(client.cyrb128(str)).toEqual(server.cyrb128(str));
        }
    });
});
