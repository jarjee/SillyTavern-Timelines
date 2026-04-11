import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { _testExports as client } from '../../tl_node_data.js';
import { _testExports as server } from '../../server-plugin/index.js';

function loadFixture(name) {
    return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
}

function buildElements(impl, fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = impl.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([fileName, messages]) => [fileName, messages.length]));
    return impl.buildGraph(preprocessed, lengths);
}

function buildAdjacency(elements) {
    const adjacency = new Map();

    elements.forEach(element => {
        if (element.group === 'nodes') {
            adjacency.set(element.data.id, []);
        }
    });

    elements.forEach(element => {
        if (element.group !== 'edges') {
            return;
        }
        const source = element.data.source;
        const target = element.data.target;
        if (!adjacency.has(source)) {
            adjacency.set(source, []);
        }
        if (!adjacency.has(target)) {
            adjacency.set(target, []);
        }
        adjacency.get(source).push(target);
    });

    return adjacency;
}

function hasDirectedCycle(elements) {
    const adjacency = buildAdjacency(elements);
    const state = new Map();

    function dfs(nodeId) {
        state.set(nodeId, 1); // visiting
        const neighbors = adjacency.get(nodeId) ?? [];
        for (const nextId of neighbors) {
            const nextState = state.get(nextId) ?? 0;
            if (nextState === 1) {
                return true;
            }
            if (nextState === 0 && dfs(nextId)) {
                return true;
            }
        }
        state.set(nodeId, 2); // done
        return false;
    }

    for (const nodeId of adjacency.keys()) {
        if ((state.get(nodeId) ?? 0) === 0 && dfs(nodeId)) {
            return true;
        }
    }

    return false;
}

const fixtures = [
    'empty',
    'single-message',
    'simple-branching',
    'checkpoint-tree',
    'complex-tree',
    'swipe-heavy',
    'parallel-edge-stress',
];

describe('buildGraph creates acyclic graphs', () => {
    for (const [label, impl] of [['client', client], ['server', server]]) {
        for (const fixtureName of fixtures) {
            it(`${label} buildGraph is acyclic on ${fixtureName}`, () => {
                const elements = buildElements(impl, loadFixture(fixtureName));
                expect(hasDirectedCycle(elements)).toBe(false);
            });
        }
    }
});
