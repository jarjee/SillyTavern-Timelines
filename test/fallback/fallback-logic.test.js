/**
 * Tests the fallback logic in prepareData():
 * - Server returns valid bulk data → use it (serverComputed: true)
 * - Server returns 404 → fall back to individual requests
 * - Server throws network error → fall back gracefully
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Override stubs before importing the module under test.
// These vi.mock calls are hoisted by vitest, so they run before imports.
vi.mock('../../stubs/script.stub.js', () => ({
    characters: [{ avatar: 'character.png', name: 'TestChar' }],
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    openCharacterChat: () => {},
    saveSettingsDebounced: () => {},
    getThumbnailUrl: () => '',
    addOneMessage: () => {},
    event_types: {},
    eventSource: { on: () => {}, emit: async () => {} },
}));

vi.mock('../../stubs/extensions.stub.js', () => ({
    extension_settings: { timeline: {} },
    getContext: () => ({ characterId: 0, groupId: null, groups: [], characters: [] }),
    loadExtensionSettings: () => {},
}));

import { prepareData } from '../../tl_node_data.js';

const MOCK_GRAPH = [
    { group: 'nodes', data: { id: 'root', label: 'root', name: 'Bot', send_date: '', x: 0, y: 0 } },
    { group: 'nodes', data: { id: 'message1', msg: 'Hello', chat_depth: 0, isBookmark: false } },
    { group: 'edges', data: { id: 'edge1', source: 'root', target: 'message1' } },
];

// Minimal chat data for fallback path
const MOCK_CHAT_LIST = {
    'chat_001.jsonl': { file_name: 'chat_001.jsonl', file_id: '1' },
};

const MOCK_CHAT_MESSAGES = [
    // first message is metadata header (gets shifted off)
    { chat_metadata: {} },
    { mes: 'Hello', name: 'Bot', is_user: false, is_system: false, is_name: true, send_date: 'Jan 1' },
];

function makeFetchOk(body) {
    return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    });
}

function makeFetch404() {
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
}

function makeFetchError() {
    return Promise.reject(new Error('Network error'));
}

describe('prepareData fallback logic', () => {
    let mockFetch;

    beforeEach(() => {
        mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('uses server graph when bulk endpoint returns valid data', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
                graph: MOCK_GRAPH,
                serverComputed: true,
            }),
        });

        const result = await prepareData(MOCK_CHAT_LIST, false, null);

        expect(result.graph).toEqual(MOCK_GRAPH);
        expect(result.serverComputed).toBe(true);
        // Only one fetch call (the bulk endpoint)
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toContain('bulk-fetch');
    });

    it('serverComputed=false when server returns serverComputed:false', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
                graph: MOCK_GRAPH,
                serverComputed: false,
            }),
        });

        const result = await prepareData(MOCK_CHAT_LIST, false, null);
        expect(result.serverComputed).toBe(false);
    });

    it('falls back to individual requests on 404 from bulk endpoint', async () => {
        // First call: bulk endpoint → 404
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });
        // Second call: individual chat fetch
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve(MOCK_CHAT_MESSAGES),
        });

        const result = await prepareData(MOCK_CHAT_LIST, false, null);

        expect(result.serverComputed).toBe(false);
        expect(result.graph).toBeDefined();
        expect(Array.isArray(result.graph)).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][0]).toContain('/api/chats/get');
    });

    it('falls back gracefully when bulk endpoint throws network error', async () => {
        // First call: network error
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        // Second call: individual chat fetch
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve(MOCK_CHAT_MESSAGES),
        });

        const result = await prepareData(MOCK_CHAT_LIST, false, null);

        expect(result.serverComputed).toBe(false);
        expect(result.graph).toBeDefined();
    });

    it('falls back on non-ok non-404 status from bulk endpoint', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve(MOCK_CHAT_MESSAGES),
        });

        const result = await prepareData(MOCK_CHAT_LIST, false, null);

        expect(result.serverComputed).toBe(false);
    });

    it('fallback strips metadata header for individual chats', async () => {
        mockFetch
            .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve([
                    { chat_metadata: { main_chat: 'root' } }, // metadata header
                    { mes: 'First message', name: 'Bot', is_user: false, is_system: false, is_name: true, send_date: 'Jan 1' },
                ]),
            });

        const result = await prepareData(MOCK_CHAT_LIST, false, null);

        // The graph should have been built from the message (not the metadata header)
        const nodes = result.graph.filter(e => e.group === 'nodes' && e.data.id !== 'root');
        expect(nodes.length).toBeGreaterThan(0);
        // No node should have chat_metadata as its msg
        nodes.forEach(n => {
            expect(n.data.msg).not.toContain('chat_metadata');
        });
    });

    it('group chat: does NOT strip first message (no metadata header)', async () => {
        mockFetch
            .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve([
                    { mes: 'First group message', name: 'Bot', is_user: false, is_system: false, is_name: true, send_date: 'Jan 1' },
                ]),
            });

        const result = await prepareData(MOCK_CHAT_LIST, true /* isGroupChat */, null);

        // Should use /api/chats/group/get endpoint
        const fallbackCall = mockFetch.mock.calls[1];
        expect(fallbackCall[0]).toContain('/api/chats/group/get');

        // First message should be preserved (not shifted off)
        const nodes = result.graph.filter(e => e.group === 'nodes' && e.data.id !== 'root');
        expect(nodes.length).toBeGreaterThan(0);
        expect(nodes[0].data.msg).toBe('First group message');
    });
});
