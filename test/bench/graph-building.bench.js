import { describe, bench } from 'vitest';
import { readFileSync } from 'fs';
import { _testExports as server } from '../../server-plugin/index.js';
import { _testExports as client } from '../../tl_node_data.js';

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

const complexTree = load('complex-tree');
const checkpointTree = load('checkpoint-tree');

function buildServer(fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = server.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    return server.buildGraph(preprocessed, lengths);
}

function buildClient(fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = client.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    return client.buildGraph(preprocessed, lengths);
}

describe('buildGraph', () => {
    bench('server - complex-tree', () => {
        buildServer(complexTree);
    });

    bench('client - complex-tree', () => {
        buildClient(complexTree);
    });
});

describe('highlightCheckpointPaths', () => {
    bench('server - checkpoint-tree', () => {
        const elements = buildServer(checkpointTree);
        server.highlightCheckpointPaths(elements);
    });
});

describe('convertToCytoscapeElements (full pipeline)', () => {
    bench('server - complex-tree', () => {
        server.convertToCytoscapeElements(JSON.parse(JSON.stringify(complexTree)));
    });

    bench('client - complex-tree', () => {
        client.convertToCytoscapeElements(JSON.parse(JSON.stringify(complexTree)));
    });
});

const LAYOUT_SETTINGS = {
    nodeSep: 50, edgeSep: 10, rankSep: 50,
    rankDir: 'LR', ranker: 'longest-path',
    spacingFactor: 1, acyclicer: 'greedy', align: undefined,
    nodeWidth: 25, nodeHeight: 25,
    swipeScale: false, avatarAsRoot: true,
};

describe('computeLayout', () => {
    bench('server - complex-tree', () => {
        const elements = buildServer(complexTree);
        server.computeLayout(elements, LAYOUT_SETTINGS);
    });
});
