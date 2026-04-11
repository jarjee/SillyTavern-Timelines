import { describe, it, expect } from 'vitest';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createContext, runInContext } from 'vm';
import { _testExports as server } from '../../server-plugin/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

const dagrePath = path.resolve(__dirname, '../../dagre.js');
const dagreSrc = readFileSync(dagrePath, 'utf8');
const dagreCtx = createContext({ module: { exports: {} }, exports: {}, global: {}, window: {}, self: {} });
runInContext(dagreSrc, dagreCtx);
const dagre = dagreCtx.module.exports;

const LAYOUT = {
    nodeSep: 50,
    edgeSep: 10,
    rankSep: 50,
    rankDir: 'LR',
    ranker: 'longest-path',
    spacingFactor: 1,
    acyclicer: 'greedy',
    nodeWidth: 25,
    nodeHeight: 25,
    swipeScale: false,
    avatarAsRoot: true,
};

function buildElements(fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture));
    const preprocessed = server.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    const elements = server.buildGraph(preprocessed, lengths);
    return server.highlightCheckpointPaths(elements);
}

function clientLikeLayout(elements, layoutSettings) {
    const g = new dagre.graphlib.Graph({ multigraph: true, compound: true });
    const gObj = {
        nodesep: layoutSettings.nodeSep,
        edgesep: layoutSettings.edgeSep,
        ranksep: layoutSettings.rankSep,
        rankdir: layoutSettings.rankDir,
        ranker: layoutSettings.ranker,
        acyclicer: layoutSettings.acyclicer,
    };
    g.setGraph(gObj);
    g.setDefaultEdgeLabel(function () { return {}; });
    g.setDefaultNodeLabel(function () { return {}; });

    const nodes = elements
        .filter(e => e.group === 'nodes')
        .sort((a, b) => (a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0));
    const edges = elements.filter(e => e.group === 'edges');

    for (const node of nodes) {
        const isRoot = node.data.label === 'root';
        const w = isRoot && layoutSettings.avatarAsRoot ? 40 : layoutSettings.nodeWidth;
        const h = isRoot && layoutSettings.avatarAsRoot ? 50 : layoutSettings.nodeHeight;
        g.setNode(node.data.id, { width: w, height: h, name: node.data.id });
    }

    for (const edge of edges) {
        g.setEdge(
            edge.data.source,
            edge.data.target,
            { minlen: 1, weight: 1, name: edge.data.id },
            edge.data.id,
        );
    }

    dagre.layout(g);

    return Object.fromEntries(nodes.map(n => {
        const p = g.node(n.data.id);
        return [n.data.id, { x: p.x * layoutSettings.spacingFactor, y: p.y * layoutSettings.spacingFactor }];
    }));
}

function pairwiseOrderAgreement(orderA, orderB) {
    const idxA = Object.fromEntries(orderA.map((id, i) => [id, i]));
    const idxB = Object.fromEntries(orderB.map((id, i) => [id, i]));
    let same = 0;
    let total = 0;

    for (let i = 0; i < orderA.length; i++) {
        for (let j = i + 1; j < orderA.length; j++) {
            const aFirst = idxA[orderA[i]] < idxA[orderA[j]];
            const bFirst = idxB[orderA[i]] < idxB[orderA[j]];
            if (aFirst === bFirst) same += 1;
            total += 1;
        }
    }

    return total === 0 ? 1 : same / total;
}

describe('layout canary parity', () => {
    for (const fixtureName of ['complex-tree', 'parallel-edge-stress']) {
        it(`${fixtureName}: server layout stays broadly aligned with client-like dagre layout`, () => {
            const elementsForServer = buildElements(load(fixtureName));
            const elementsForClientLike = JSON.parse(JSON.stringify(elementsForServer));

            server.computeLayout(elementsForServer, LAYOUT);
            const clientPositions = clientLikeLayout(elementsForClientLike, LAYOUT);

            const serverNodes = elementsForServer.filter(e => e.group === 'nodes');
            const serverIds = serverNodes.map(n => n.data.id).sort();
            const clientIds = Object.keys(clientPositions).sort();

            expect(serverIds).toEqual(clientIds);

            const serverById = Object.fromEntries(serverNodes.map(n => [n.data.id, n.position]));
            for (const id of serverIds) {
                expect(Number.isFinite(serverById[id].x), `server ${id} x`).toBe(true);
                expect(Number.isFinite(serverById[id].y), `server ${id} y`).toBe(true);
                expect(Number.isFinite(clientPositions[id].x), `client-like ${id} x`).toBe(true);
                expect(Number.isFinite(clientPositions[id].y), `client-like ${id} y`).toBe(true);
            }

            const serverOrder = [...serverIds].sort((a, b) => serverById[a].x - serverById[b].x);
            const clientOrder = [...serverIds].sort((a, b) => clientPositions[a].x - clientPositions[b].x);
            const agreement = pairwiseOrderAgreement(serverOrder, clientOrder);

            expect(agreement).toBeGreaterThan(0.7);
        });
    }
});
