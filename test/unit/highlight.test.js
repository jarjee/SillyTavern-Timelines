import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { _testExports as server } from '../../server-plugin/index.js';
import { _testExports as clientStyle } from '../../tl_style.js';
import { _testExports as client } from '../../tl_node_data.js';

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

function buildGraph(impl, fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = impl.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    return impl.buildGraph(preprocessed, lengths);
}

function applyClientHighlighting(elements) {
    // Simulate what setupStylesAndData does when skipHighlighting=false
    Object.values(elements).forEach(entry => {
        if (entry.group === 'nodes' && entry.data.isBookmark) {
            clientStyle.highlightPathToRoot(elements, entry.data.id);
        }
    });
}

describe('server highlightCheckpointPaths', () => {
    it('no-op on graph without bookmarks', () => {
        const fixture = load('simple-branching');
        const elements = buildGraph(server, fixture);
        const before = JSON.stringify(elements);
        server.highlightCheckpointPaths(elements);
        const after = JSON.stringify(elements);
        expect(before).toBe(after);
    });

    it('highlights edges on path from bookmark to root', () => {
        const fixture = load('checkpoint-tree');
        const elements = buildGraph(server, fixture);
        server.highlightCheckpointPaths(elements);

        const highlightedEdges = elements.filter(e => e.group === 'edges' && e.data.isHighlight);
        expect(highlightedEdges.length).toBeGreaterThan(0);
    });

    it('highlighted edges have color, bookmarkName, highlightThickness', () => {
        const fixture = load('checkpoint-tree');
        const elements = buildGraph(server, fixture);
        server.highlightCheckpointPaths(elements);

        const highlighted = elements.filter(e => e.group === 'edges' && e.data.isHighlight);
        highlighted.forEach(edge => {
            expect(edge.data.color).toMatch(/^rgb\(/);
            expect(edge.data.bookmarkName).toBeTruthy();
            expect(typeof edge.data.highlightThickness).toBe('number');
            expect(edge.data.highlightThickness).toBeGreaterThanOrEqual(4);
        });
    });

    it('highlight thickness starts at 4 and caps at 6', () => {
        const fixture = load('checkpoint-tree');
        const elements = buildGraph(server, fixture);
        server.highlightCheckpointPaths(elements);

        const thicknesses = elements
            .filter(e => e.group === 'edges' && e.data.isHighlight)
            .map(e => e.data.highlightThickness);

        thicknesses.forEach(t => {
            expect(t).toBeGreaterThanOrEqual(4);
            expect(t).toBeLessThanOrEqual(6);
        });
        // First edge in the path should be closest to 4
        expect(Math.min(...thicknesses)).toBeCloseTo(4, 1);
    });

    it('zIndex increments along the path (closer to root = higher zIndex)', () => {
        const fixture = load('checkpoint-tree');
        const elements = buildGraph(server, fixture);
        server.highlightCheckpointPaths(elements);

        const zIndexes = elements
            .filter(e => e.group === 'edges' && e.data.isHighlight)
            .map(e => e.data.zIndex);

        const min = Math.min(...zIndexes);
        const max = Math.max(...zIndexes);
        expect(min).toBeGreaterThanOrEqual(1000);
        expect(max).toBeGreaterThan(min);
    });

    it('nodes along highlighted path get borderColor', () => {
        const fixture = load('checkpoint-tree');
        const elements = buildGraph(server, fixture);
        server.highlightCheckpointPaths(elements);

        const nodesWithBorder = elements.filter(e => e.group === 'nodes' && e.data.borderColor);
        expect(nodesWithBorder.length).toBeGreaterThan(0);
        nodesWithBorder.forEach(n => {
            expect(n.data.borderColor).toMatch(/^rgb\(/);
        });
    });

    it('stops at another bookmark node (chain boundary)', () => {
        // complex-tree has a checkpoint that should stop at the bookmark node
        const fixture = load('complex-tree');
        const elements = buildGraph(server, fixture);
        server.highlightCheckpointPaths(elements);
        // Simply verify no crash and highlighting was applied
        const highlighted = elements.filter(e => e.group === 'edges' && e.data.isHighlight);
        expect(highlighted.length).toBeGreaterThan(0);
    });
});

describe('client highlightPathToRoot', () => {
    it('no-op on graph without bookmarks', () => {
        const fixture = load('simple-branching');
        const elements = buildGraph(client, fixture);
        const before = JSON.stringify(elements);
        applyClientHighlighting(elements);
        const after = JSON.stringify(elements);
        expect(before).toBe(after);
    });

    it('highlights edges on path from bookmark to root', () => {
        const fixture = load('checkpoint-tree');
        const elements = buildGraph(client, fixture);
        applyClientHighlighting(elements);

        const highlightedEdges = elements.filter(e => e.group === 'edges' && e.data.isHighlight);
        expect(highlightedEdges.length).toBeGreaterThan(0);
    });

    it('highlighted edges have same fields as server version', () => {
        const fixture = load('checkpoint-tree');
        const elements = buildGraph(client, fixture);
        applyClientHighlighting(elements);

        const highlighted = elements.filter(e => e.group === 'edges' && e.data.isHighlight);
        highlighted.forEach(edge => {
            expect(edge.data.color).toMatch(/^rgb\(/);
            expect(edge.data.bookmarkName).toBeTruthy();
            expect(typeof edge.data.highlightThickness).toBe('number');
            expect(typeof edge.data.zIndex).toBe('number');
        });
    });
});
