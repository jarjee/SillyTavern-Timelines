import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { _testExports as server } from '../../server-plugin/index.js';
import { _testExports as client } from '../../tl_node_data.js';

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

// Run full convertToCytoscapeElements pipeline
function runServer(fixture) {
    return server.convertToCytoscapeElements(JSON.parse(JSON.stringify(fixture)));
}

function runClient(fixture) {
    return client.convertToCytoscapeElements(JSON.parse(JSON.stringify(fixture)));
}

describe('server convertToCytoscapeElements (includes highlighting)', () => {
    it('empty fixture returns only root node', () => {
        const result = runServer(load('empty'));
        expect(result).toHaveLength(1);
        expect(result[0].data.id).toBe('root');
    });

    it('single-message returns root + 1 node + 1 edge', () => {
        const result = runServer(load('single-message'));
        const nodes = result.filter(e => e.group === 'nodes');
        const edges = result.filter(e => e.group === 'edges');
        expect(nodes).toHaveLength(2);
        expect(edges).toHaveLength(1);
    });

    it('checkpoint-tree: bookmark nodes have highlighting applied', () => {
        const result = runServer(load('checkpoint-tree'));
        const highlighted = result.filter(e => e.group === 'edges' && e.data.isHighlight);
        expect(highlighted.length).toBeGreaterThan(0);
    });

    it('checkpoint-tree: bookmark node has color assigned', () => {
        const result = runServer(load('checkpoint-tree'));
        const bookmarks = result.filter(e => e.group === 'nodes' && e.data.isBookmark);
        expect(bookmarks.length).toBeGreaterThan(0);
        bookmarks.forEach(b => expect(b.data.color).toMatch(/^rgb\(/));
    });

    it('simple-branching: correct branching structure', () => {
        const result = runServer(load('simple-branching'));
        const nodes = result.filter(e => e.group === 'nodes' && e.data.id !== 'root');
        // Depth 0 and 1 are shared: 1 unique node ID each (may appear multiple times in array)
        const depth0 = nodes.filter(n => n.data.chat_depth === 0);
        const uniqueDepth0Ids = new Set(depth0.map(n => n.data.id));
        expect(uniqueDepth0Ids.size).toBe(1);
        expect(Object.keys(depth0[0].data.chat_sessions)).toHaveLength(3);
    });

    it('swipe-heavy: nodes have storedSwipes data', () => {
        const result = runServer(load('swipe-heavy'));
        const nodesWithSwipes = result.filter(e => e.group === 'nodes' && e.data.totalSwipes > 0);
        expect(nodesWithSwipes.length).toBeGreaterThan(0);
    });

    it('all elements have required fields', () => {
        const result = runServer(load('complex-tree'));
        result.forEach(el => {
            expect(el.group).toMatch(/^(nodes|edges)$/);
            expect(el.data).toBeDefined();
            expect(el.data.id).toBeDefined();
            if (el.group === 'edges') {
                expect(el.data.source).toBeDefined();
                expect(el.data.target).toBeDefined();
            }
        });
    });
});

describe('client convertToCytoscapeElements (no highlighting)', () => {
    it('empty fixture returns only root node', () => {
        const result = runClient(load('empty'));
        expect(result).toHaveLength(1);
    });

    it('checkpoint-tree: NO highlighting in client output', () => {
        const result = runClient(load('checkpoint-tree'));
        // Client does NOT apply highlighting - that's done in setupStylesAndData
        const highlighted = result.filter(e => e.group === 'edges' && e.data.isHighlight);
        expect(highlighted).toHaveLength(0);
    });

    it('same node/edge count as server (excluding highlight fields)', () => {
        const fixtures = ['simple-branching', 'deep-conversation', 'swipe-heavy', 'multi-character'];
        for (const name of fixtures) {
            const fixture = load(name);
            const serverResult = runServer(fixture);
            const clientResult = runClient(fixture);
            const serverNodes = serverResult.filter(e => e.group === 'nodes').length;
            const clientNodes = clientResult.filter(e => e.group === 'nodes').length;
            const serverEdges = serverResult.filter(e => e.group === 'edges').length;
            const clientEdges = clientResult.filter(e => e.group === 'edges').length;
            expect(clientNodes).toBe(serverNodes);
            expect(clientEdges).toBe(serverEdges);
        }
    });
});
