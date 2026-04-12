/**
 * Unit tests for the disk cache helper functions in server-plugin/index.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { _testExports } from '../../server-plugin/index.js';

const {
    computeLayoutHash,
    buildContextSlug,
    buildSourceFingerprint,
    getDiskCacheDir,
    getDiskCachePaths,
    readDiskCache,
    writeDiskCache,
    deleteDiskCacheForSlug,
    DISK_CACHE_SCHEMA_VERSION,
} = _testExports;

// ---------------------------------------------------------------------------
// computeLayoutHash
// ---------------------------------------------------------------------------

describe('computeLayoutHash', () => {
    const base = {
        nodeSep: 50, edgeSep: 10, rankSep: 100,
        rankDir: 'LR', ranker: 'longest-path',
        spacingFactor: 1, acyclicer: 'greedy', align: 'UL',
        nodeWidth: 25, nodeHeight: 25,
        swipeScale: false, avatarAsRoot: true,
    };

    it('same settings produce the same hash', () => {
        expect(computeLayoutHash(base)).toBe(computeLayoutHash({ ...base }));
    });

    it('changing a geometry field produces a different hash', () => {
        expect(computeLayoutHash(base)).not.toBe(computeLayoutHash({ ...base, nodeSep: 999 }));
    });

    it('is key-order independent', () => {
        const reordered = {
            avatarAsRoot: base.avatarAsRoot,
            swipeScale: base.swipeScale,
            nodeHeight: base.nodeHeight,
            nodeWidth: base.nodeWidth,
            align: base.align,
            acyclicer: base.acyclicer,
            spacingFactor: base.spacingFactor,
            ranker: base.ranker,
            rankDir: base.rankDir,
            rankSep: base.rankSep,
            edgeSep: base.edgeSep,
            nodeSep: base.nodeSep,
        };
        expect(computeLayoutHash(base)).toBe(computeLayoutHash(reordered));
    });

    it('null layout produces a stable hash', () => {
        expect(computeLayoutHash(null)).toBe(computeLayoutHash(null));
        expect(computeLayoutHash(null)).toBe(computeLayoutHash(undefined));
    });

    it('extra style-only fields have no effect (only LAYOUT_KEYS are hashed)', () => {
        const withExtra = { ...base, nodeColor: 'red', legendVisible: false };
        expect(computeLayoutHash(base)).toBe(computeLayoutHash(withExtra));
    });

    it('returns a 12-character lowercase hex string', () => {
        const h = computeLayoutHash(base);
        expect(h).toMatch(/^[0-9a-f]{12}$/);
    });
});

// ---------------------------------------------------------------------------
// buildContextSlug
// ---------------------------------------------------------------------------

describe('buildContextSlug', () => {
    it('produces char_ prefix for non-group', () => {
        expect(buildContextSlug(false, 'character.png')).toBe('char_character.png');
    });

    it('produces group_ prefix for groups', () => {
        expect(buildContextSlug(true, '5')).toBe('group_5');
    });

    it('sanitizes spaces and special characters', () => {
        expect(buildContextSlug(false, 'my char/name.png')).toBe('char_my_char_name.png');
    });

    it('sanitizes slashes (no path separators in output)', () => {
        const slug = buildContextSlug(false, '../../../etc/passwd');
        // Slashes are replaced — the slug is always a flat filename component
        expect(slug).not.toContain('/');
        expect(slug.startsWith('char_')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// buildSourceFingerprint
// ---------------------------------------------------------------------------

describe('buildSourceFingerprint', () => {
    const stats = [
        { filename: 'chat_001.jsonl', mtimeMs: 1000, size: 500 },
        { filename: 'chat_002.jsonl', mtimeMs: 2000, size: 600 },
    ];

    it('same file set produces the same fingerprint', () => {
        expect(buildSourceFingerprint(stats)).toBe(buildSourceFingerprint([...stats]));
    });

    it('different mtime produces a different fingerprint', () => {
        const modified = [{ ...stats[0], mtimeMs: 9999 }, stats[1]];
        expect(buildSourceFingerprint(stats)).not.toBe(buildSourceFingerprint(modified));
    });

    it('different size produces a different fingerprint', () => {
        const modified = [{ ...stats[0], size: 1 }, stats[1]];
        expect(buildSourceFingerprint(stats)).not.toBe(buildSourceFingerprint(modified));
    });

    it('is order-independent', () => {
        const reversed = [...stats].reverse();
        expect(buildSourceFingerprint(stats)).toBe(buildSourceFingerprint(reversed));
    });

    it('empty list produces a stable hash', () => {
        expect(buildSourceFingerprint([])).toBe(buildSourceFingerprint([]));
    });

    it('returns a 16-character lowercase hex string', () => {
        expect(buildSourceFingerprint(stats)).toMatch(/^[0-9a-f]{16}$/);
    });
});

// ---------------------------------------------------------------------------
// getDiskCacheDir / getDiskCachePaths
// ---------------------------------------------------------------------------

describe('getDiskCacheDir', () => {
    it('returns root/.timelines', () => {
        const dir = getDiskCacheDir({ root: '/user/root' });
        expect(dir).toBe(path.join('/user/root', '.timelines'));
    });
});

describe('getDiskCachePaths', () => {
    it('returns manifest and data paths with correct naming convention', () => {
        const paths = getDiskCachePaths('/cache', 'char_bot.png', 'abc123');
        expect(paths.manifest).toBe(path.join('/cache', 'graph_char_bot.png_abc123.manifest.json'));
        expect(paths.data).toBe(path.join('/cache', 'graph_char_bot.png_abc123.json.gz'));
    });
});

// ---------------------------------------------------------------------------
// readDiskCache
// ---------------------------------------------------------------------------

describe('readDiskCache', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-cache-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true });
    });

    async function writeValidCache(paths, layoutHash, fingerprint, gzipData) {
        await fs.mkdir(path.dirname(paths.manifest), { recursive: true });
        const manifest = {
            schemaVersion: DISK_CACHE_SCHEMA_VERSION,
            layoutHash,
            sourceFingerprint: fingerprint,
            contextKey: 'char:bot.png',
            createdAt: Date.now(),
        };
        await fs.writeFile(paths.manifest, JSON.stringify(manifest), 'utf8');
        await fs.writeFile(paths.data, gzipData);
    }

    it('returns null when manifest file does not exist', async () => {
        const paths = getDiskCachePaths(tmpDir, 'char_bot', 'abc123');
        expect(await readDiskCache(paths, 'abc123', 'fp1')).toBeNull();
    });

    it('returns null when manifest has wrong schemaVersion', async () => {
        const paths = getDiskCachePaths(tmpDir, 'char_bot', 'abc123');
        const manifest = { schemaVersion: 999, layoutHash: 'abc123', sourceFingerprint: 'fp1' };
        await fs.writeFile(paths.manifest, JSON.stringify(manifest), 'utf8');
        await fs.writeFile(paths.data, Buffer.from('fake'));
        expect(await readDiskCache(paths, 'abc123', 'fp1')).toBeNull();
    });

    it('returns null when layoutHash does not match', async () => {
        const paths = getDiskCachePaths(tmpDir, 'char_bot', 'abc123');
        await writeValidCache(paths, 'abc123', 'fp1', Buffer.from('fake'));
        expect(await readDiskCache(paths, 'different_hash', 'fp1')).toBeNull();
    });

    it('returns null when sourceFingerprint does not match', async () => {
        const paths = getDiskCachePaths(tmpDir, 'char_bot', 'abc123');
        await writeValidCache(paths, 'abc123', 'fp1', Buffer.from('fake'));
        expect(await readDiskCache(paths, 'abc123', 'different_fp')).toBeNull();
    });

    it('returns null when manifest is valid but .json.gz is missing', async () => {
        const paths = getDiskCachePaths(tmpDir, 'char_bot', 'abc123');
        const manifest = {
            schemaVersion: DISK_CACHE_SCHEMA_VERSION,
            layoutHash: 'abc123',
            sourceFingerprint: 'fp1',
        };
        await fs.writeFile(paths.manifest, JSON.stringify(manifest), 'utf8');
        // No data file written
        expect(await readDiskCache(paths, 'abc123', 'fp1')).toBeNull();
    });

    it('returns null when manifest JSON is corrupt', async () => {
        const paths = getDiskCachePaths(tmpDir, 'char_bot', 'abc123');
        await fs.writeFile(paths.manifest, '{ not valid json !!!', 'utf8');
        expect(await readDiskCache(paths, 'abc123', 'fp1')).toBeNull();
    });

    it('returns the gzip Buffer when all fields match', async () => {
        const paths = getDiskCachePaths(tmpDir, 'char_bot', 'abc123');
        const fakeGzip = Buffer.from('fake-gzip-content');
        await writeValidCache(paths, 'abc123', 'fp1', fakeGzip);
        const result = await readDiskCache(paths, 'abc123', 'fp1');
        expect(result).toBeInstanceOf(Buffer);
        expect(result).toEqual(fakeGzip);
    });
});

// ---------------------------------------------------------------------------
// writeDiskCache
// ---------------------------------------------------------------------------

describe('writeDiskCache', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-cache-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true });
    });

    it('writes manifest and data files atomically (no .tmp files after success)', async () => {
        const cacheDir = path.join(tmpDir, '.timelines');
        const paths = getDiskCachePaths(cacheDir, 'char_bot', 'abc123');
        const manifest = { schemaVersion: DISK_CACHE_SCHEMA_VERSION, layoutHash: 'abc123' };
        const gzipData = Buffer.from('fake-gz');

        await writeDiskCache(paths, manifest, gzipData);

        const files = await fs.readdir(cacheDir);
        expect(files).toContain('graph_char_bot_abc123.manifest.json');
        expect(files).toContain('graph_char_bot_abc123.json.gz');
        // No temp files should remain
        expect(files.every(f => !f.endsWith('.tmp'))).toBe(true);
    });

    it('manifest content matches what was written', async () => {
        const cacheDir = path.join(tmpDir, '.timelines');
        const paths = getDiskCachePaths(cacheDir, 'char_bot', 'abc123');
        const manifest = { schemaVersion: DISK_CACHE_SCHEMA_VERSION, layoutHash: 'abc123', sourceFingerprint: 'fp999' };
        await writeDiskCache(paths, manifest, Buffer.from('gz'));

        const raw = await fs.readFile(paths.manifest, 'utf8');
        expect(JSON.parse(raw)).toMatchObject(manifest);
    });

    it('does not throw when the cacheDir is a file (write failure is non-fatal)', async () => {
        // Make the parent dir a file instead of a directory to cause a write failure
        const badCacheDir = path.join(tmpDir, 'not-a-dir');
        await fs.writeFile(badCacheDir, 'this is a file, not a dir', 'utf8');
        const paths = getDiskCachePaths(badCacheDir, 'char_bot', 'abc123');

        await expect(
            writeDiskCache(paths, { schemaVersion: 1 }, Buffer.from('gz'))
        ).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// deleteDiskCacheForSlug
// ---------------------------------------------------------------------------

describe('deleteDiskCacheForSlug', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-cache-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true });
    });

    it('deletes matching manifest and .json.gz files', async () => {
        await fs.writeFile(path.join(tmpDir, 'graph_char_bot_abc.manifest.json'), '{}', 'utf8');
        await fs.writeFile(path.join(tmpDir, 'graph_char_bot_abc.json.gz'), Buffer.from('gz'));

        await deleteDiskCacheForSlug(tmpDir, 'char_bot');

        const files = await fs.readdir(tmpDir);
        expect(files).toHaveLength(0);
    });

    it('does not delete files for other slugs', async () => {
        await fs.writeFile(path.join(tmpDir, 'graph_char_bot_abc.manifest.json'), '{}', 'utf8');
        await fs.writeFile(path.join(tmpDir, 'graph_group_5_abc.manifest.json'), '{}', 'utf8');

        await deleteDiskCacheForSlug(tmpDir, 'char_bot');

        const files = await fs.readdir(tmpDir);
        expect(files).toEqual(['graph_group_5_abc.manifest.json']);
    });

    it('handles non-existent cacheDir without throwing', async () => {
        const missing = path.join(tmpDir, 'no-such-dir');
        await expect(deleteDiskCacheForSlug(missing, 'char_bot')).resolves.not.toThrow();
    });

    it('deletes multiple layout variants for the same slug', async () => {
        await fs.writeFile(path.join(tmpDir, 'graph_char_bot_hash1.manifest.json'), '{}', 'utf8');
        await fs.writeFile(path.join(tmpDir, 'graph_char_bot_hash1.json.gz'), Buffer.from('gz'));
        await fs.writeFile(path.join(tmpDir, 'graph_char_bot_hash2.manifest.json'), '{}', 'utf8');
        await fs.writeFile(path.join(tmpDir, 'graph_char_bot_hash2.json.gz'), Buffer.from('gz'));

        await deleteDiskCacheForSlug(tmpDir, 'char_bot');

        const files = await fs.readdir(tmpDir);
        expect(files).toHaveLength(0);
    });
});
