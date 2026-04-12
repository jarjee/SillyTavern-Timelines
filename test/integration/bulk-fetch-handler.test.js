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

const {
    resolveChatDirectory, getCacheKey, responseCache,
    computeLayoutHash, buildContextSlug, buildSourceFingerprint,
    getDiskCacheDir, getDiskCachePaths, readDiskCache,
    DISK_CACHE_SCHEMA_VERSION,
} = _testExports;

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
function makeReq(body, chatsDir, groupChatsDir, userHandle = 'test-user', headers = {}, rootDir = null, groupsDir = null) {
    return {
        body,
        headers,
        user: {
            profile: { handle: userHandle },
            directories: {
                root: rootDir ?? chatsDir,
                chats: chatsDir,
                groupChats: groupChatsDir,
                groups: groupsDir ?? path.join(chatsDir, 'groups'),
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
let invalidateCacheHandler;

beforeAll(async () => {
    const mockRouter = createMockRouter();
    await init(mockRouter);
    bulkFetchHandler = mockRouter._handlers['/bulk-fetch'];
    invalidateCacheHandler = mockRouter._handlers['/invalidate-cache'];
});

afterAll(() => {
    responseCache.clear();
});

// Minimal JSONL chat content (metadata line + 1 message for individual chat)
const MINIMAL_JSONL = [
    JSON.stringify({ chat_metadata: { main_chat: '' } }),
    JSON.stringify({ name: 'Bot', is_user: false, is_system: false, is_name: true, mes: 'Hello', send_date: 'Jan 1', swipes: [] }),
].join('\n');

async function writeFixtureAsIndividualChats(charDir, fixture) {
    await fs.mkdir(charDir, { recursive: true });
    for (const [fileName, messages] of Object.entries(fixture)) {
        const jsonl = [
            JSON.stringify({ chat_metadata: { main_chat: '' } }),
            ...messages.map(msg => JSON.stringify(msg)),
        ].join('\n');
        await fs.writeFile(path.join(charDir, fileName), jsonl, 'utf8');
    }
}

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

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
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

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('reads from groupChats dir when is_group=true', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupChatsDir = path.join(tmpDir, 'group chats');
        const groupsDir = path.join(tmpDir, 'groups');
        await fs.mkdir(groupChatsDir, { recursive: true });
        await fs.mkdir(groupsDir, { recursive: true });

        // Group chats don't have a metadata line; write one message only
        const groupMsg = JSON.stringify({ name: 'Bot', is_user: false, is_system: false, is_name: true, mes: 'Hi group', send_date: 'Jan 1', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'group_001.jsonl'), groupMsg, 'utf8');

        // Write group metadata so the backend can resolve group.chats
        await fs.writeFile(
            path.join(groupsDir, 'group-id-abc.json'),
            JSON.stringify({ id: 'group-id-abc', name: 'Test Group', chats: ['group_001.jsonl'] }),
            'utf8',
        );

        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'group-id-abc', is_group: true, group_id: 'group-id-abc' },
            path.join(tmpDir, 'chats'),
            groupChatsDir,
            'test-user', {}, tmpDir, groupsDir,
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(Array.isArray(res._body.graph)).toBe(true);
        const nodes = res._body.graph.filter(e => e.group === 'nodes');
        expect(nodes.length).toBeGreaterThan(1);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('returns metadata for all chat files with larger folders', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Large Character');
        await fs.mkdir(charDir, { recursive: true });

        const fileCount = 24;
        for (let i = 0; i < fileCount; i++) {
            await fs.writeFile(path.join(charDir, `chat_${String(i).padStart(3, '0')}.jsonl`), MINIMAL_JSONL, 'utf8');
        }

        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'Large Character.png', is_group: false },
            tmpDir,
            path.join(tmpDir, 'group chats'),
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(Object.keys(res._body.metadata)).toHaveLength(fileCount);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
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

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('computes layout for group chats and returns serverComputed:true with positions', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupChatsDir = path.join(tmpDir, 'group chats');
        const groupsDir = path.join(tmpDir, 'groups');
        await fs.mkdir(groupChatsDir, { recursive: true });
        await fs.mkdir(groupsDir, { recursive: true });

        const groupMsg = JSON.stringify({ name: 'Bot', is_user: false, is_system: false, is_name: true, mes: 'Hi group', send_date: 'Jan 1', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'group_001.jsonl'), groupMsg, 'utf8');
        await fs.writeFile(
            path.join(groupsDir, 'group-id-abc.json'),
            JSON.stringify({ id: 'group-id-abc', name: 'Test Group', chats: ['group_001.jsonl'] }),
            'utf8',
        );

        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'group-id-abc', is_group: true, layout_settings: LAYOUT_SETTINGS, group_id: 'group-id-abc' },
            path.join(tmpDir, 'chats'),
            groupChatsDir,
            'test-user', {}, tmpDir, groupsDir,
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

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('stress fixture corpus computes layout without 500 and returns positioned nodes', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Stress Felix');
        const fixtureRaw = await fs.readFile(new URL('../fixtures/parallel-edge-stress.json', import.meta.url), 'utf8');
        const fixture = JSON.parse(fixtureRaw);

        await writeFixtureAsIndividualChats(charDir, fixture);
        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'Stress Felix.png', is_group: false, layout_settings: LAYOUT_SETTINGS },
            tmpDir,
            path.join(tmpDir, 'group chats'),
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(res._body.serverComputed).toBe(true);
        expect(Array.isArray(res._body.graph)).toBe(true);
        expect(res._body.graph.length).toBeGreaterThan(20);

        const nodes = res._body.graph.filter(e => e.group === 'nodes');
        expect(nodes.length).toBeGreaterThan(10);
        for (const node of nodes) {
            expect(node.position, `node ${node.data.id} missing position`).toBeDefined();
            expect(Number.isFinite(node.position.x), `node ${node.data.id} x`).toBe(true);
            expect(Number.isFinite(node.position.y), `node ${node.data.id} y`).toBe(true);
        }

        const edges = res._body.graph.filter(e => e.group === 'edges');
        expect(edges.length).toBeGreaterThan(10);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });
});

describe('bulk-fetch handler: content encoding', () => {
    it('sends gzip only when client accepts gzip', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false },
            tmpDir,
            path.join(tmpDir, 'group chats'),
            'test-user',
            { 'accept-encoding': 'gzip, deflate' },
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(res._headers['content-encoding']).toBe('gzip');
        expect(Array.isArray(res._body.graph)).toBe(true);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('serves cached response correctly for gzip and plain clients', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        const reqGzip = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false },
            tmpDir,
            path.join(tmpDir, 'group chats'),
            'test-user',
            { 'accept-encoding': 'gzip' },
        );
        const resGzip = makeRes();
        await bulkFetchHandler(reqGzip, resGzip);
        expect(resGzip._headers['content-encoding']).toBe('gzip');

        const reqPlain = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false },
            tmpDir,
            path.join(tmpDir, 'group chats'),
        );
        const resPlain = makeRes();
        await bulkFetchHandler(reqPlain, resPlain);

        expect(resPlain._statusCode).toBe(200);
        expect(resPlain._headers['content-encoding']).toBeUndefined();
        expect(Array.isArray(resPlain._body.graph)).toBe(true);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
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

// ---------------------------------------------------------------------------
// Group scoping: only reads chats listed in group metadata
// ---------------------------------------------------------------------------

describe('bulk-fetch handler: group scoping', () => {
    it('returns 400 when is_group=true but group_id is missing', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'group-avatar.png', is_group: true },
            tmpDir,
            path.join(tmpDir, 'group chats'),
            'test-user', {}, tmpDir,
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(400);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('returns empty graph when group metadata file is not found', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupsDir = path.join(tmpDir, 'groups');
        await fs.mkdir(groupsDir, { recursive: true });
        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'ghost.png', is_group: true, group_id: 'nonexistent-group' },
            path.join(tmpDir, 'chats'),
            path.join(tmpDir, 'group chats'),
            'test-user', {}, tmpDir, groupsDir,
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(res._body.graph).toEqual([]);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('only reads chats listed in group metadata, ignoring other files in groupChats dir', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupChatsDir = path.join(tmpDir, 'group chats');
        const groupsDir = path.join(tmpDir, 'groups');
        await fs.mkdir(groupChatsDir, { recursive: true });
        await fs.mkdir(groupsDir, { recursive: true });

        // group A owns only group_a_001.jsonl
        const msgA = JSON.stringify({ name: 'Alice', is_user: false, is_system: false, is_name: true, mes: 'Hello from A', send_date: 'Jan 1', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'group_a_001.jsonl'), msgA, 'utf8');

        // unrelated file in the same directory (belongs to group B)
        const msgB = JSON.stringify({ name: 'Bob', is_user: false, is_system: false, is_name: true, mes: 'Hello from B', send_date: 'Jan 2', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'group_b_001.jsonl'), msgB, 'utf8');

        await fs.writeFile(
            path.join(groupsDir, '1.json'),
            JSON.stringify({ id: '1', name: 'Group A', chats: ['group_a_001.jsonl'] }),
            'utf8',
        );

        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'group_a_avatar.png', is_group: true, group_id: '1' },
            path.join(tmpDir, 'chats'),
            groupChatsDir,
            'test-user', {}, tmpDir, groupsDir,
        );
        const res = makeRes();

        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(res._body.metadata).toBeDefined();
        expect(Object.keys(res._body.metadata)).toContain('group_a_001.jsonl');
        expect(Object.keys(res._body.metadata)).not.toContain('group_b_001.jsonl');

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('two groups with different chat lists produce different graphs', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupChatsDir = path.join(tmpDir, 'group chats');
        const groupsDir = path.join(tmpDir, 'groups');
        await fs.mkdir(groupChatsDir, { recursive: true });
        await fs.mkdir(groupsDir, { recursive: true });

        const msgA = JSON.stringify({ name: 'Alice', is_user: false, is_system: false, is_name: true, mes: 'Group A message', send_date: 'Jan 1', swipes: [] });
        const msgB = JSON.stringify({ name: 'Bob', is_user: false, is_system: false, is_name: true, mes: 'Group B message', send_date: 'Jan 2', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'chat_a.jsonl'), msgA, 'utf8');
        await fs.writeFile(path.join(groupChatsDir, 'chat_b.jsonl'), msgB, 'utf8');

        await fs.writeFile(path.join(groupsDir, '1.json'), JSON.stringify({ id: '1', name: 'Group A', chats: ['chat_a.jsonl'] }), 'utf8');
        await fs.writeFile(path.join(groupsDir, '2.json'), JSON.stringify({ id: '2', name: 'Group B', chats: ['chat_b.jsonl'] }), 'utf8');

        responseCache.clear();

        const reqA = makeReq(
            { avatar_url: 'avatar_a.png', is_group: true, group_id: '1' },
            path.join(tmpDir, 'chats'), groupChatsDir, 'test-user', {}, tmpDir, groupsDir,
        );
        const resA = makeRes();
        await bulkFetchHandler(reqA, resA);

        const reqB = makeReq(
            { avatar_url: 'avatar_b.png', is_group: true, group_id: '2' },
            path.join(tmpDir, 'chats'), groupChatsDir, 'test-user', {}, tmpDir, groupsDir,
        );
        const resB = makeRes();
        await bulkFetchHandler(reqB, resB);

        expect(resA._statusCode).toBe(200);
        expect(resB._statusCode).toBe(200);
        expect(JSON.stringify(resA._body.graph)).not.toBe(JSON.stringify(resB._body.graph));

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });
});

// ---------------------------------------------------------------------------
// Disk cache: persistence across requests
// ---------------------------------------------------------------------------

describe('bulk-fetch handler: disk cache', () => {
    it('first request writes manifest + .json.gz to .timelines/', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        const req = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: LAYOUT_SETTINGS },
            tmpDir, path.join(tmpDir, 'group chats'),
            'test-user', {}, tmpDir,
        );
        const res = makeRes();
        await bulkFetchHandler(req, res);
        // Allow the fire-and-forget write to complete
        await new Promise(r => setTimeout(r, 100));

        expect(res._statusCode).toBe(200);
        const cacheDir = path.join(tmpDir, '.timelines');
        const files = await fs.readdir(cacheDir);
        expect(files.some(f => f.endsWith('.manifest.json'))).toBe(true);
        expect(files.some(f => f.endsWith('.json.gz'))).toBe(true);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('second request with unchanged files hits disk cache and returns same graph', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        const body = { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: LAYOUT_SETTINGS };

        // First request — full rebuild + disk write
        const req1 = makeReq(body, tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir);
        const res1 = makeRes();
        await bulkFetchHandler(req1, res1);
        await new Promise(r => setTimeout(r, 100));

        // Clear memory cache to force disk read on second request
        responseCache.clear();

        const req2 = makeReq(body, tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir);
        const res2 = makeRes();
        await bulkFetchHandler(req2, res2);

        expect(res2._statusCode).toBe(200);
        expect(JSON.stringify(res2._body.graph)).toBe(JSON.stringify(res1._body.graph));

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('changed file mtime forces disk cache miss and rebuild', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        const chatFile = path.join(charDir, 'chat_001.jsonl');
        await fs.writeFile(chatFile, MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        const body = { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: LAYOUT_SETTINGS };

        const req1 = makeReq(body, tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir);
        const res1 = makeRes();
        await bulkFetchHandler(req1, res1);
        await new Promise(r => setTimeout(r, 100));

        // Rewrite the file (changes mtime)
        await fs.writeFile(chatFile, MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        const req2 = makeReq(body, tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir);
        const res2 = makeRes();
        await bulkFetchHandler(req2, res2);

        expect(res2._statusCode).toBe(200);
        expect(Array.isArray(res2._body.graph)).toBe(true);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('layout settings change forces rebuild (different layoutHash)', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        const layout1 = { ...LAYOUT_SETTINGS, nodeSep: 50 };
        const layout2 = { ...LAYOUT_SETTINGS, nodeSep: 999 };

        const req1 = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: layout1 },
            tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir,
        );
        const res1 = makeRes();
        await bulkFetchHandler(req1, res1);
        await new Promise(r => setTimeout(r, 100));

        responseCache.clear();

        const req2 = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: layout2 },
            tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir,
        );
        const res2 = makeRes();
        await bulkFetchHandler(req2, res2);
        await new Promise(r => setTimeout(r, 100));

        // Both requests succeed; different layout hashes mean different disk cache files
        expect(computeLayoutHash(layout1)).not.toBe(computeLayoutHash(layout2));
        const cacheDir = path.join(tmpDir, '.timelines');
        const files = await fs.readdir(cacheDir);
        expect(files.filter(f => f.endsWith('.manifest.json')).length).toBe(2);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('corrupt manifest falls back to full rebuild without error', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        // Pre-write a corrupt manifest
        const cacheDir = path.join(tmpDir, '.timelines');
        await fs.mkdir(cacheDir, { recursive: true });
        const slug = buildContextSlug(false, 'Dungeon master.png');
        const hash = computeLayoutHash(LAYOUT_SETTINGS);
        const diskPaths = getDiskCachePaths(cacheDir, slug, hash);
        await fs.writeFile(diskPaths.manifest, '{ not valid json !!!', 'utf8');

        const req = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: LAYOUT_SETTINGS },
            tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir,
        );
        const res = makeRes();
        await bulkFetchHandler(req, res);

        expect(res._statusCode).toBe(200);
        expect(Array.isArray(res._body.graph)).toBe(true);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });
});

// ---------------------------------------------------------------------------
// Invalidation: clears disk cache
// ---------------------------------------------------------------------------

describe('invalidate-cache handler: disk cache cleanup', () => {
    it('removes manifest and .json.gz for the invalidated context', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const charDir = path.join(tmpDir, 'Dungeon master');
        await fs.mkdir(charDir, { recursive: true });
        await fs.writeFile(path.join(charDir, 'chat_001.jsonl'), MINIMAL_JSONL, 'utf8');
        responseCache.clear();

        // First, build the disk cache
        const body = { avatar_url: 'Dungeon master.png', is_group: false, layout_settings: LAYOUT_SETTINGS };
        const req1 = makeReq(body, tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir);
        const res1 = makeRes();
        await bulkFetchHandler(req1, res1);
        await new Promise(r => setTimeout(r, 100));

        const cacheDir = path.join(tmpDir, '.timelines');
        const before = await fs.readdir(cacheDir);
        expect(before.length).toBeGreaterThan(0);

        // Now invalidate
        const invReq = makeReq(
            { avatar_url: 'Dungeon master.png', is_group: false },
            tmpDir, path.join(tmpDir, 'group chats'), 'test-user', {}, tmpDir,
        );
        const invRes = makeRes();
        await invalidateCacheHandler(invReq, invRes);

        const after = await fs.readdir(cacheDir);
        const remaining = after.filter(f => f.endsWith('.manifest.json') || f.endsWith('.json.gz'));
        expect(remaining).toHaveLength(0);

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });

    it('group A invalidation does not delete group B disk cache', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-test-'));
        const groupChatsDir = path.join(tmpDir, 'group chats');
        const groupsDir = path.join(tmpDir, 'groups');
        await fs.mkdir(groupChatsDir, { recursive: true });
        await fs.mkdir(groupsDir, { recursive: true });

        const msg = JSON.stringify({ name: 'Bot', is_user: false, is_system: false, is_name: true, mes: 'Hi', send_date: 'Jan 1', swipes: [] });
        await fs.writeFile(path.join(groupChatsDir, 'chat_a.jsonl'), msg, 'utf8');
        await fs.writeFile(path.join(groupChatsDir, 'chat_b.jsonl'), msg, 'utf8');
        await fs.writeFile(path.join(groupsDir, '1.json'), JSON.stringify({ id: '1', name: 'A', chats: ['chat_a.jsonl'] }), 'utf8');
        await fs.writeFile(path.join(groupsDir, '2.json'), JSON.stringify({ id: '2', name: 'B', chats: ['chat_b.jsonl'] }), 'utf8');

        responseCache.clear();

        // Build cache for both groups
        for (const [gid, avatar] of [['1', 'a.png'], ['2', 'b.png']]) {
            const req = makeReq(
                { avatar_url: avatar, is_group: true, group_id: gid, layout_settings: LAYOUT_SETTINGS },
                path.join(tmpDir, 'chats'), groupChatsDir, 'test-user', {}, tmpDir, groupsDir,
            );
            await bulkFetchHandler(req, makeRes());
        }
        await new Promise(r => setTimeout(r, 100));

        const cacheDir = path.join(tmpDir, '.timelines');
        const before = await fs.readdir(cacheDir);
        expect(before.filter(f => f.endsWith('.manifest.json')).length).toBe(2);

        // Invalidate group A only
        const invReq = makeReq(
            { avatar_url: 'a.png', is_group: true, group_id: '1' },
            path.join(tmpDir, 'chats'), groupChatsDir, 'test-user', {}, tmpDir, groupsDir,
        );
        const invRes = makeRes();
        await invalidateCacheHandler(invReq, invRes);

        const after = await fs.readdir(cacheDir);
        const manifests = after.filter(f => f.endsWith('.manifest.json'));
        expect(manifests).toHaveLength(1);
        expect(manifests[0]).toContain('group_2');

        await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 50 });
    });
});
