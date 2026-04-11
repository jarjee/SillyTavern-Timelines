import { describe, expect, it } from 'vitest';
import { applyIncrementalMessageUpdate, resolveTimelineChatFileName } from '../../tl_incremental.js';

function makeBaseGraph() {
    return [
        {
            group: 'nodes',
            data: {
                id: 'root',
                label: 'root',
                name: 'Alice',
            },
            position: { x: 0, y: 0 },
        },
        {
            group: 'nodes',
            data: {
                id: 'message1',
                msg: 'hello',
                chat_depth: 0,
                is_user: false,
                is_system: false,
                name: 'Alice',
                send_date: 't0',
                chat_sessions: {
                    'chatA.jsonl': { messageId: 0, indexInGroup: 0, length: 1 },
                },
            },
            position: { x: 120, y: 0 },
        },
        {
            group: 'edges',
            data: { id: 'edge1', source: 'root', target: 'message1' },
        },
    ];
}

describe('resolveTimelineChatFileName', () => {
    it('resolves bare chat id to .jsonl session file', () => {
        const graph = makeBaseGraph();
        expect(resolveTimelineChatFileName('chatA', graph)).toBe('chatA.jsonl');
    });

    it('resolves chat id when extension is already present', () => {
        const graph = makeBaseGraph();
        expect(resolveTimelineChatFileName('chatA.jsonl', graph)).toBe('chatA.jsonl');
    });

    it('returns null when chat id cannot be matched', () => {
        const graph = makeBaseGraph();
        graph[1].data.chat_sessions['chatB.jsonl'] = { messageId: 0, indexInGroup: 1, length: 1 };
        expect(resolveTimelineChatFileName('chatC', graph)).toBeNull();
    });
});

describe('applyIncrementalMessageUpdate', () => {
    it('appends a new node and edge for append-only message', () => {
        const graph = makeBaseGraph();

        const result = applyIncrementalMessageUpdate({
            graphElements: graph,
            fileName: 'chatA.jsonl',
            messageId: 1,
            message: {
                mes: 'new user line',
                is_user: true,
                is_system: false,
                is_name: true,
                name: 'You',
                send_date: 't1',
            },
            rankDir: 'LR',
            rankStep: 100,
        });

        expect(result.applied).toBe(true);
        expect(result.reason).toBe('added_new_node');

        const appendedNode = graph.find(element => element.group === 'nodes' && element.data.chat_depth === 1);
        expect(appendedNode).toBeDefined();
        expect(appendedNode.data.chat_sessions['chatA.jsonl'].length).toBe(2);

        const newEdge = graph.find(element => element.group === 'edges' && element.data.target === appendedNode.data.id);
        expect(newEdge).toBeDefined();
        expect(newEdge.data.source).toBe('message1');

        const previousNode = graph.find(element => element.group === 'nodes' && element.data.id === 'message1');
        expect(previousNode.data.chat_sessions['chatA.jsonl'].length).toBe(2);
    });

    it('updates an existing merged node when depth+text already exists', () => {
        const graph = makeBaseGraph();

        graph[1].data.chat_sessions['chatB.jsonl'] = { messageId: 0, indexInGroup: 1, length: 1 };
        graph.push({
            group: 'nodes',
            data: {
                id: 'message2',
                msg: 'shared follow-up',
                chat_depth: 1,
                is_user: true,
                is_system: false,
                name: 'You',
                send_date: 't1',
                chat_sessions: {
                    'chatB.jsonl': { messageId: 1, indexInGroup: 0, length: 2 },
                },
            },
            position: { x: 220, y: 0 },
        });
        graph.push({ group: 'edges', data: { id: 'edge2', source: 'message1', target: 'message2' } });

        const result = applyIncrementalMessageUpdate({
            graphElements: graph,
            fileName: 'chatA.jsonl',
            messageId: 1,
            message: {
                mes: 'shared follow-up',
                is_user: true,
                is_system: false,
                name: 'You',
                send_date: 't1',
            },
            rankDir: 'LR',
            rankStep: 100,
        });

        expect(result.applied).toBe(true);
        expect(result.reason).toBe('updated_existing_node');

        const nodeAtDepthOne = graph.find(element => element.group === 'nodes' && element.data.id === 'message2');
        expect(nodeAtDepthOne.data.chat_sessions['chatA.jsonl']).toEqual({ messageId: 1, indexInGroup: 0, length: 2 });

        const nodeCount = graph.filter(element => element.group === 'nodes' && element.data.id !== 'root').length;
        expect(nodeCount).toBe(2);
    });

    it('refuses non-append updates and asks caller to rebuild', () => {
        const graph = makeBaseGraph();

        const result = applyIncrementalMessageUpdate({
            graphElements: graph,
            fileName: 'chatA.jsonl',
            messageId: 0,
            message: {
                mes: 'edited greeting',
                is_user: false,
                is_system: false,
                name: 'Alice',
                send_date: 't0',
            },
            rankDir: 'LR',
            rankStep: 100,
        });

        expect(result.applied).toBe(false);
        expect(result.reason).toBe('non_append');
    });

    it('refuses unsupported alternative swipe payloads', () => {
        const graph = makeBaseGraph();

        const result = applyIncrementalMessageUpdate({
            graphElements: graph,
            fileName: 'chatA.jsonl',
            messageId: 1,
            message: {
                mes: 'assistant answer',
                swipes: ['assistant answer', 'alternative answer'],
                is_user: false,
                is_system: false,
                name: 'Alice',
                send_date: 't1',
            },
            rankDir: 'LR',
            rankStep: 100,
        });

        expect(result.applied).toBe(false);
        expect(result.reason).toBe('unsupported_swipes');
    });
});
