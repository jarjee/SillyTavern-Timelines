import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { _testExports as server } from '../../server-plugin/index.js';
import { _testExports as client } from '../../tl_node_data.js';

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

// Test both implementations
const impls = [
    { name: 'server', ...server },
    { name: 'client', ...client },
];

function buildFromFixture(impl, fixture) {
    const fresh = JSON.parse(JSON.stringify(fixture)); // avoid mutation across tests
    const preprocessed = impl.preprocessChatSessions(fresh);
    const lengths = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]));
    return impl.buildGraph(preprocessed, lengths);
}

for (const impl of impls) {
    describe(`buildGraph [${impl.name}]`, () => {
        it('empty input produces only root node', () => {
            const elements = impl.buildGraph([], {});
            expect(elements).toHaveLength(1);
            expect(elements[0].data.id).toBe('root');
            expect(elements[0].group).toBe('nodes');
        });

        it('root node has correct structure', () => {
            const fixture = load('single-message');
            const elements = buildFromFixture(impl, fixture);
            const root = elements.find(e => e.data.id === 'root');
            expect(root).toBeDefined();
            expect(root.group).toBe('nodes');
            expect(root.data.label).toBe('root');
            expect(typeof root.data.name).toBe('string');
        });

        it('root node name is sorted AI character names', () => {
            const fixture = load('multi-character');
            const elements = buildFromFixture(impl, fixture);
            const root = elements.find(e => e.data.id === 'root');
            // multi-character has Alice, Bob, Carol - sorted
            expect(root.data.name).toBe('Alice, Bob, Carol');
        });

        it('single-message fixture produces 1 root + 1 node + 1 edge', () => {
            const fixture = load('single-message');
            const elements = buildFromFixture(impl, fixture);
            const nodes = elements.filter(e => e.group === 'nodes');
            const edges = elements.filter(e => e.group === 'edges');
            expect(nodes).toHaveLength(2); // root + 1
            expect(edges).toHaveLength(1);
            expect(edges[0].data.source).toBe('root');
        });

        it('simple-branching: shared prefix merges into single nodes', () => {
            const fixture = load('simple-branching');
            const elements = buildFromFixture(impl, fixture);
            const nodes = elements.filter(e => e.group === 'nodes' && e.data.id !== 'root');
            // buildGraph pushes one entry per chat file per message group, but shared messages
            // all reference the same node data (same id). Deduplication means 1 unique node ID
            // per depth level for shared messages.
            const depth0Nodes = nodes.filter(e => e.data.chat_depth === 0);
            const depth1Nodes = nodes.filter(e => e.data.chat_depth === 1);
            const uniqueDepth0Ids = new Set(depth0Nodes.map(n => n.data.id));
            const uniqueDepth1Ids = new Set(depth1Nodes.map(n => n.data.id));
            expect(uniqueDepth0Ids.size).toBe(1); // deduplicated
            expect(uniqueDepth1Ids.size).toBe(1); // deduplicated

            // chat_sessions on the shared node should span all 3 files
            expect(Object.keys(depth0Nodes[0].data.chat_sessions)).toHaveLength(3);
        });

        it('simple-branching: diverging messages create branches', () => {
            const fixture = load('simple-branching');
            const elements = buildFromFixture(impl, fixture);
            const nodes = elements.filter(e => e.group === 'nodes' && e.data.id !== 'root');
            // After depth 1, chats diverge - each file has its own messages
            const depth2Nodes = nodes.filter(e => e.data.chat_depth === 2);
            expect(depth2Nodes).toHaveLength(3); // one per file
        });

        it('node IDs follow message{N} pattern', () => {
            const fixture = load('single-message');
            const elements = buildFromFixture(impl, fixture);
            const msgNodes = elements.filter(e => e.group === 'nodes' && e.data.id !== 'root');
            msgNodes.forEach(n => {
                expect(n.data.id).toMatch(/^message\d+$/);
            });
        });

        it('edge IDs are unique', () => {
            const fixture = load('simple-branching');
            const elements = buildFromFixture(impl, fixture);
            const edges = elements.filter(e => e.group === 'edges');
            const ids = edges.map(e => e.data.id);
            expect(new Set(ids).size).toBe(ids.length);
        });

        it('all edges have valid source and target', () => {
            const fixture = load('simple-branching');
            const elements = buildFromFixture(impl, fixture);
            const nodeIds = new Set(elements.filter(e => e.group === 'nodes').map(e => e.data.id));
            const edges = elements.filter(e => e.group === 'edges');
            edges.forEach(edge => {
                expect(nodeIds.has(edge.data.source)).toBe(true);
                expect(nodeIds.has(edge.data.target)).toBe(true);
            });
        });

        it('swipe-heavy: swipe data attached to parent nodes', () => {
            const fixture = load('swipe-heavy');
            const elements = buildFromFixture(impl, fixture);
            const nodesWithSwipes = elements.filter(
                e => e.group === 'nodes' && e.data.totalSwipes > 0
            );
            expect(nodesWithSwipes.length).toBeGreaterThan(0);
            nodesWithSwipes.forEach(node => {
                expect(Array.isArray(node.data.storedSwipes)).toBe(true);
                expect(node.data.storedSwipes.length).toBeGreaterThan(0);
                // Each swipe entry has {node, edge}
                node.data.storedSwipes.forEach(swipe => {
                    expect(swipe.node).toBeDefined();
                    expect(swipe.edge).toBeDefined();
                    expect(swipe.node.isSwipe).toBe(true);
                    expect(swipe.edge.isSwipe).toBe(true);
                });
            });
        });

        it('swipe-heavy: no swipe nodes at depth 0 (greetings excluded)', () => {
            const fixture = load('swipe-heavy');
            const elements = buildFromFixture(impl, fixture);
            // The first node (depth 0) should have no actual swipes attached
            // (parentSwipeData may set totalSwipes=0 but storedSwipes should be empty)
            const depth0Nodes = elements.filter(
                e => e.group === 'nodes' && e.data.chat_depth === 0
            );
            depth0Nodes.forEach(node => {
                const swipes = node.data.storedSwipes;
                expect(!swipes || swipes.length === 0).toBe(true);
            });
        });

        it('checkpoint-tree: bookmark node detected and color assigned', () => {
            const fixture = load('checkpoint-tree');
            const elements = buildFromFixture(impl, fixture);
            const bookmarkNodes = elements.filter(e => e.group === 'nodes' && e.data.isBookmark);
            expect(bookmarkNodes.length).toBeGreaterThan(0);
            bookmarkNodes.forEach(node => {
                expect(node.data.color).toMatch(/^rgb\(/);
                expect(node.data.bookmarkName).toBeTruthy();
            });
        });

        it('dead-bookmark: dead link is demoted to non-bookmark', () => {
            const fixture = load('dead-bookmark');
            const elements = buildFromFixture(impl, fixture);
            // The checkpoint message points to 'missing_branch' which doesn't exist
            const bookmarkNodes = elements.filter(e => e.group === 'nodes' && e.data.isBookmark);
            expect(bookmarkNodes).toHaveLength(0);
        });

        it('newline-normalization: \\r\\n messages deduplicate with \\n versions', () => {
            const fixture = load('newline-normalization');
            const elements = buildFromFixture(impl, fixture);
            // Both files have same messages just with different line endings
            // After normalization, they should deduplicate to 2 unique node IDs
            const nodes = elements.filter(e => e.group === 'nodes' && e.data.id !== 'root');
            const uniqueIds = new Set(nodes.map(n => n.data.id));
            // 2 messages per file, both normalized to same text = 2 unique nodes
            expect(uniqueIds.size).toBe(2);
            // Each unique node should span both files
            uniqueIds.forEach(id => {
                const node = nodes.find(n => n.data.id === id);
                expect(Object.keys(node.data.chat_sessions)).toHaveLength(2);
            });
        });

        it('chat_sessions maps file names to {messageId, indexInGroup, length}', () => {
            const fixture = load('single-message');
            const elements = buildFromFixture(impl, fixture);
            const msgNode = elements.find(e => e.data.id !== 'root' && e.group === 'nodes');
            expect(msgNode.data.chat_sessions).toBeDefined();
            const sessions = msgNode.data.chat_sessions;
            const filename = Object.keys(fixture)[0];
            expect(sessions[filename]).toBeDefined();
            expect(sessions[filename].messageId).toBe(0);
            expect(typeof sessions[filename].length).toBe('number');
        });
    });
}
