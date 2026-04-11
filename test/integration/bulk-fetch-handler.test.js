/**
 * Smoketest for the bulk-fetch route handler in server-plugin/index.js.
 *
 * We don't spin up a real Express server. Instead we register routes against
 * a minimal mock router, then invoke the captured handler directly with
 * mock req/res objects. This lets us exercise the path-resolution and
 * file-reading logic without any HTTP layer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { gunzipSync } from 'zlib';
import { init, _testExports } from '../../server-plugin/index.js';

const { resolveChatDirectory, getCacheKey, responseCache } = _testExports;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock router that captures handlers registered with .post() */
function createMockRouter() {
    const handlers = {};
    return {
        post(routePath, handler) { handlers[routePath] = handler; },
        _handlers: handlers,
    };
}

/** Build a mock Express request */
function makeReq(body, chatsDir, groupChatsDir, userHandle = 'test-user') {
    return {
        body,
        user: {
            profile: { handle: userHandle },
            directories: {
                chats: chatsDir,
                groupChats: groupChatsDir,
            },
        },
    };
}

/** Build a mock Express response that captures json() or gzipped end() calls */
function makeRes() {
    const res = {
        _statusCode: 200,
        _body: undefined,
        _headers: {},
        status(code) { res._statusCode = code; return res; },
        json(body) { res._body = body; },
        setHeader(name, value) { res._headers[name.toLowerCase()] = value; },
        end(buffer) {
            if (res._headers['content-encoding'] === 'gzip') {
                res._body = JSON.parse(gunzipSync(buffer).toString('utf8'));
            } else {
                res._body = JSON.parse(buffer.toString('utf8'));
            }
        },
    };
    return res;
}

// ---------------------------------------------------------------------------
// Shared setup: register the handler once, create temp dirs per-test
// ---------------------------------------------------------------------------

let bulkFetchHandler;

beforeAll(async () => {
    const mockRouter = createMockRouter();
    await init(mockRouter);
    bulkFetchHandler = mockRouter._handlers['/bulk-fetch'];
});

afterAll(() => {
    responseCache.clear();
});

// Minimal JSONL chat content (metadata line + 1 message for individual chat)
const MINIMAL_JSONL = [
    JSON.stringify({ chat_metadata: { main_chat: '' } }),
    JSON.stringify({ name: 'Bot', is_user: false, is_system: false, is_name: true, mes: 'Hello', send_date: 'Jan 1', swipes: [] }),
].join('\n');

// ---------------------------------------------------------------------------
// resolveChatDirectory (pure function unit tests)
// ---------------------------------------------------------------------------

describe('resolveChatDirectory', () => {
    const dirs = {
        chats: '/data/user/chats',
        groupChats: '/data/user/group chats',
    };

    it('non-group: joins chats dir with avatar name (strips .png)', () => {
        const result = resolveChatDirectory(dirs, 'Dungeon master.png', false);
        expect(result).toBe(path.join('/data/user/chats', 'Dungeon master'));
    });

    it('non-group: does not strip non-.png extensions', () => {
        // SillyTavern only strips .png; we match that behavior
        const result = resolveChatDirectory(dirs, 'Character.jpg', false);
        expect(result).toBe(path.join('/data/user/chats', 'Character.jpg'));
    });

    it('group: returns groupChats directory directly', () => {
        const result = resolveChatDirectory(dirs, 'group-id-123', true);
        expect(result).toBe('/data/user/group chats');
    });
});

// ---------------------------------------------------------------------------
// Bulk-fetch handler: missing directory → empty graph, no fallback
// ---------------------------------------------------------------------------

describe('bulk-fetch handler: missing chat directory', () => {
    it('returns empty graph (not an error) when directory does not exist', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const nonExistentCharDir = path.join(tmpDir, 'NonExistentChar');
        // Do NOT create nonExistentCharDir

        const req = makeReq(
            { avatar_url: 'NonExistentChar.png', is_group: false },
            tmpDir,
            path.join(tmpDir, 'group chats'),
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(res._body).toBeDefined();
        expect(res._body.graph).toEqual([]);
        expect(res._body.serverComputed).toBe(false);

        await fs.rm(tmpDir, { recursive: true });
    });
});

// ---------------------------------------------------------------------------
// Bulk-fetch handler: reads from req.user.directories.chats (correct path)
// ---------------------------------------------------------------------------

describe('bulk-fetch handler: correct path resolution', () => {
    it('reads chat files from req.user.directories.chats/<charname>', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charName = 'Dungeon master';
        const charDir = path.join(tmpDir, charName);
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');

        // Clear cache so we don't hit a stale entry
        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false },
            tmpDir,
            path.join(tmpDir, 'group chats'),
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(Array.isArray(res._body.graph)).toBe(true);
        // Should have at least a root node and one message node
        const nodeIds = res._body.graph.filter(e => e.group === 'nodes').map(e => e.data.id);
        expect(nodeIds).toContain('root');
        expect(nodeIds.length).toBeGreaterThan(1);

        await fs.rm(tmpDir, { recursive: true });
    });

    it('reads from groupChats dir when is_group=true', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupChatsDir = path.join(tmpDir, 'group chats');
        await fs.mkdir(groupChatsDir, { recursive: true });

        // Group chats don't have a metadata line; write one message only
        const groupMsg = JSON.stringify({ name: 'Bot', is_user: false, is_system: false, is_name: true, mes: 'Hi group', send_date: 'Jan 1', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'group_001.jsonl'), groupMsg, 'utf8');

        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'group-id-abc', is_group: true },
            path.join(tmpDir, 'chats'),
            groupChatsDir,
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(Array.isArray(res._body.graph)).toBe(true);
        const nodes = res._body.graph.filter(e => e.group === 'nodes');
        expect(nodes.length).toBeGreaterThan(1);

        await fs.rm(tmpDir, { recursive: true });
    });
});

// ---------------------------------------------------------------------------
// Bulk-fetch handler: layout_settings triggers server-side computeLayout
// ---------------------------------------------------------------------------

const LAYOUT_SETTINGS = {
    nodeSep: 50, edgeSep: 10, rankSep: 50,
    rankDir: 'LR', ranker: 'longest-path',
    spacingFactor: 1, acyclicer: 'greedy', align: undefined,
    nodeWidth: 25, nodeHeight: 25,
    swipeScale: false, avatarAsRoot: true,
};

describe('bulk-fetch handler: layout_settings', () => {
    it('computes layout for individual chats and returns serverComputed:true with positions', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');

        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: LAYOUT_SETTINGS },
            tmpDir,
            path.join(tmpDir, 'group chats'),
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(res._body.serverComputed).toBe(true);

        const nodes = res._body.graph.filter(e => e.group === 'nodes');
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) {
            expect(node.position, `node ${node.data.id} missing position`).toBeDefined();
            expect(typeof node.position.x).toBe('number');
            expect(typeof node.position.y).toBe('number');
            expect(Number.isFinite(node.position.x)).toBe(true);
            expect(Number.isFinite(node.position.y)).toBe(true);
        }

        await fs.rm(tmpDir, { recursive: true });
    });

    it('computes layout for group chats and returns serverComputed:true with positions', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupChatsDir = path.join(tmpDir, 'group chats');
        await fs.mkdir(groupChatsDir, { recursive: true });

        const groupMsg = JSON.stringify({ name: 'Bot', is_user: false, is_system: false, is_name: true, mes: 'Hi group', send_date: 'Jan 1', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'group_001.jsonl'), groupMsg, 'utf8');

        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'group-id-abc', is_group: true, layout_settings: LAYOUT_SETTINGS },
            path.join(tmpDir, 'chats'),
            groupChatsDir,
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(res._body.serverComputed).toBe(true);

        const nodes = res._body.graph.filter(e => e.group === 'nodes');
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) {
            expect(node.position, `node ${node.data.id} missing position`).toBeDefined();
            expect(Number.isFinite(node.position.x)).toBe(true);
            expect(Number.isFinite(node.position.y)).toBe(true);
        }

        await fs.rm(tmpDir, { recursive: true });
    });
});

// ---------------------------------------------------------------------------
// Cache isolation by user handle
// ---------------------------------------------------------------------------

describe('cache key isolation', () => {
    it('different user handles produce different cache keys', () => {
        const k1 = getCacheKey('avatar.png', false, null, 'alice');
        const k2 = getCacheKey('avatar.png', false, null, 'bob');
        expect(k1).not.toBe(k2);
    });

    it('same user and avatar produce the same cache key', () => {
        const k1 = getCacheKey('avatar.png', false, null, 'alice');
        const k2 = getCacheKey('avatar.png', false, null, 'alice');
        expect(k1).toBe(k2);
    });
});
