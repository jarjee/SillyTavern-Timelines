import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { _testExports as server } from '../../server-plugin/index.js';

const { computeLayout, buildGraph, preprocessChatSessions, highlightCheckpointPaths } = server;

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

// Baseline layout settings matching what the client sends
const layoutSettings = {
    nodeSep: 50,
    edgeSep: 10,
    rankSep: 50,
    rankDir: 'LR',
    ranker: 'longest-path',
    spacingFactor: 1,
    acyclicer: 'greedy',
    align: undefined,
    nodeWidth: 25,
    nodeHeight: 25,
    swipeScale: false,
    avatarAsRoot: true,
};

/** Build full Cytoscape elements (preprocess + buildGraph + highlight) from a fixture */
function buildElements(fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    const elements = buildGraph(preprocessed, lengths);
    return highlightCheckpointPaths(elements);
}

// ---------------------------------------------------------------------------
// Baseline: all fixtures produce valid positioned output
// ---------------------------------------------------------------------------

const fixtures = [
    'simple-branching',
    'checkpoint-tree',
    'complex-tree',
    'single-message',
    'empty',
    'parallel-edge-stress',
];

describe('computeLayout: baseline', () => {
    for (const name of fixtures) {
        it(`does not throw on ${name}`, () => {
            const elements = buildElements(load(name));
            expect(() => computeLayout(elements, layoutSettings)).not.toThrow();
        });

        it(`every node gets a finite position on ${name}`, () => {
            const elements = buildElements(load(name));
            computeLayout(elements, layoutSettings);
            const nodes = elements.filter(e => e.group === 'nodes');
            // empty fixture has only the root node; even that should be positioned
            for (const node of nodes) {
                expect(node.position, `node ${node.data.id} missing position`).toBeDefined();
                expect(Number.isFinite(node.position.x), `node ${node.data.id} x is not finite`).toBe(true);
                expect(Number.isFinite(node.position.y), `node ${node.data.id} y is not finite`).toBe(true);
            }
        });

        it(`edges are unchanged by layout on ${name}`, () => {
            const elements = buildElements(load(name));
            const edgesBefore = elements.filter(e => e.group === 'edges').map(e => e.data.id).sort();
            computeLayout(elements, layoutSettings);
            const edgesAfter = elements.filter(e => e.group === 'edges').map(e => e.data.id).sort();
            expect(edgesAfter).toEqual(edgesBefore);
        });
    }
});

// ---------------------------------------------------------------------------
// spacingFactor: positions scale proportionally
// ---------------------------------------------------------------------------

describe('computeLayout: spacingFactor', () => {
    it('spacingFactor:2 produces positions 2x spacingFactor:1', () => {
        const fixture = load('simple-branching');

        const els1 = buildElements(fixture);
        computeLayout(els1, { ...layoutSettings, spacingFactor: 1 });

        const els2 = buildElements(fixture);
        computeLayout(els2, { ...layoutSettings, spacingFactor: 2 });

        const pos1 = Object.fromEntries(
            els1.filter(e => e.group === 'nodes').map(e => [e.data.id, e.position])
        );
        const pos2 = Object.fromEntries(
            els2.filter(e => e.group === 'nodes').map(e => [e.data.id, e.position])
        );

        for (const id of Object.keys(pos1)) {
            expect(pos2[id].x).toBeCloseTo(pos1[id].x * 2, 5);
            expect(pos2[id].y).toBeCloseTo(pos1[id].y * 2, 5);
        }
    });
});

// ---------------------------------------------------------------------------
// All three rankers produce valid output
// ---------------------------------------------------------------------------

describe('computeLayout: rankers', () => {
    for (const ranker of ['network-simplex', 'tight-tree', 'longest-path']) {
        it(`ranker=${ranker} does not throw and produces positions`, () => {
            const elements = buildElements(load('simple-branching'));
            expect(() => computeLayout(elements, { ...layoutSettings, ranker })).not.toThrow();
            const nodes = elements.filter(e => e.group === 'nodes');
            for (const node of nodes) {
                expect(Number.isFinite(node.position?.x)).toBe(true);
                expect(Number.isFinite(node.position?.y)).toBe(true);
            }
        });
    }
});

// ---------------------------------------------------------------------------
// Both directions produce different (non-trivially identical) layouts
// ---------------------------------------------------------------------------

describe('computeLayout: rankDir', () => {
    it('LR and TB produce different position coordinates', () => {
        const fixture = load('simple-branching');

        const elsLR = buildElements(fixture);
        computeLayout(elsLR, { ...layoutSettings, rankDir: 'LR' });

        const elsTB = buildElements(fixture);
        computeLayout(elsTB, { ...layoutSettings, rankDir: 'TB' });

        const posLR = Object.fromEntries(
            elsLR.filter(e => e.group === 'nodes').map(e => [e.data.id, e.position])
        );
        const posTB = Object.fromEntries(
            elsTB.filter(e => e.group === 'nodes').map(e => [e.data.id, e.position])
        );

        // At least one node should have a different position
        const anyDiffers = Object.keys(posLR).some(
            id => posLR[id].x !== posTB[id].x || posLR[id].y !== posTB[id].y
        );
        expect(anyDiffers).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Multiedge regression: direct guard for the isMultigraph class of failures
// ---------------------------------------------------------------------------

describe('computeLayout: multiedge regression', () => {
    it('does not throw when elements contain duplicate (source, target) edges', () => {
        // This is the class of input that previously caused:
        // "Cannot set a named edge when isMultigraph = false"
        const elements = [
            { group: 'nodes', data: { id: 'root', label: 'root', name: 'Bot', send_date: '' } },
            { group: 'nodes', data: { id: 'message1', msg: 'Hello', chat_depth: 0, is_user: false, is_system: false, name: 'Bot', send_date: 'Jan 1' } },
            { group: 'nodes', data: { id: 'message2', msg: 'Reply', chat_depth: 1, is_user: true, is_system: false, name: 'User', send_date: 'Jan 1' } },
            // Duplicate edges: same source→target pair, different IDs
            { group: 'edges', data: { id: 'edge1', source: 'root', target: 'message1' } },
            { group: 'edges', data: { id: 'edge2', source: 'root', target: 'message1' } },
            { group: 'edges', data: { id: 'edge3', source: 'root', target: 'message1' } },
            { group: 'edges', data: { id: 'edge4', source: 'message1', target: 'message2' } },
        ];

        expect(() => computeLayout(elements, layoutSettings)).not.toThrow();

        const nodes = elements.filter(e => e.group === 'nodes');
        for (const node of nodes) {
            expect(Number.isFinite(node.position?.x)).toBe(true);
            expect(Number.isFinite(node.position?.y)).toBe(true);
        }
    });

    it('does not throw on fan-in: multiple parents converging to one node', () => {
        // Multiple distinct parents all pointing to the same child node
        const elements = [
            { group: 'nodes', data: { id: 'root', label: 'root', name: 'Bot', send_date: '' } },
            { group: 'nodes', data: { id: 'branchA', msg: 'Path A', chat_depth: 0, is_user: false, is_system: false, name: 'Bot', send_date: 'Jan 1' } },
            { group: 'nodes', data: { id: 'branchB', msg: 'Path B', chat_depth: 0, is_user: false, is_system: false, name: 'Bot', send_date: 'Jan 1' } },
            { group: 'nodes', data: { id: 'branchC', msg: 'Path C', chat_depth: 0, is_user: false, is_system: false, name: 'Bot', send_date: 'Jan 1' } },
            { group: 'nodes', data: { id: 'converge', msg: 'Continue', chat_depth: 1, is_user: true, is_system: false, name: 'User', send_date: 'Jan 1' } },
            { group: 'edges', data: { id: 'e1', source: 'root', target: 'branchA' } },
            { group: 'edges', data: { id: 'e2', source: 'root', target: 'branchB' } },
            { group: 'edges', data: { id: 'e3', source: 'root', target: 'branchC' } },
            // Fan-in: three different parents → same target
            { group: 'edges', data: { id: 'e4', source: 'branchA', target: 'converge' } },
            { group: 'edges', data: { id: 'e5', source: 'branchB', target: 'converge' } },
            { group: 'edges', data: { id: 'e6', source: 'branchC', target: 'converge' } },
        ];

        expect(() => computeLayout(elements, layoutSettings)).not.toThrow();

        const nodes = elements.filter(e => e.group === 'nodes');
        for (const node of nodes) {
            expect(Number.isFinite(node.position?.x)).toBe(true);
            expect(Number.isFinite(node.position?.y)).toBe(true);
        }
    });

    it('parallel-edge-stress fixture: does not throw and all nodes get positions', () => {
        const elements = buildElements(load('parallel-edge-stress'));
        expect(() => computeLayout(elements, layoutSettings)).not.toThrow();
        const nodes = elements.filter(e => e.group === 'nodes');
        for (const node of nodes) {
            expect(Number.isFinite(node.position?.x), `${node.data.id} x`).toBe(true);
            expect(Number.isFinite(node.position?.y), `${node.data.id} y`).toBe(true);
        }
    });

    it('duplicate edge pairs do not change node positions versus deduped edges', () => {
        const baseElements = [
            { group: 'nodes', data: { id: 'root', label: 'root', name: 'Bot', send_date: '' } },
            { group: 'nodes', data: { id: 'a', msg: 'A', chat_depth: 0, is_user: false, is_system: false, name: 'Bot', send_date: 'Jan 1' } },
            { group: 'nodes', data: { id: 'b', msg: 'B', chat_depth: 1, is_user: true, is_system: false, name: 'User', send_date: 'Jan 1' } },
            { group: 'edges', data: { id: 'e1', source: 'root', target: 'a' } },
            { group: 'edges', data: { id: 'e2', source: 'a', target: 'b' } },
        ];

        const withDuplicates = [
            ...baseElements,
            { group: 'edges', data: { id: 'dup1', source: 'root', target: 'a' } },
            { group: 'edges', data: { id: 'dup2', source: 'a', target: 'b' } },
        ];

        const deduped = JSON.parse(JSON.stringify(baseElements));
        const duplicated = JSON.parse(JSON.stringify(withDuplicates));

        computeLayout(deduped, layoutSettings);
        computeLayout(duplicated, layoutSettings);

        const dedupedPos = Object.fromEntries(deduped.filter(e => e.group === 'nodes').map(e => [e.data.id, e.position]));
        const duplicatedPos = Object.fromEntries(duplicated.filter(e => e.group === 'nodes').map(e => [e.data.id, e.position]));

        for (const id of Object.keys(dedupedPos)) {
            expect(duplicatedPos[id].x).toBeCloseTo(dedupedPos[id].x, 5);
            expect(duplicatedPos[id].y).toBeCloseTo(dedupedPos[id].y, 5);
        }
    });
});
