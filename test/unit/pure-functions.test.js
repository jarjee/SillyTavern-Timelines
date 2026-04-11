import { describe, it, expect } from 'vitest';
import { _testExports as server } from '../../server-plugin/index.js';

const {
    sfc32,
    cyrb128,
    generateUniqueColor,
    formatFileSize,
    getCacheKey,
    isCacheValid,
    resolveCacheTtlMs,
    CACHE_TTL,
    DEFAULT_CACHE_TTL,
} = server;

describe('sfc32', () => {
    it('returns a function', () => {
        expect(typeof sfc32(1, 2, 3, 4)).toBe('function');
    });

    it('produces values in [0, 1)', () => {
        const rng = sfc32(1234, 5678, 9012, 3456);
        for (let i = 0; i < 100; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('is deterministic with fixed seeds', () => {
        const rng1 = sfc32(1, 2, 3, 4);
        const rng2 = sfc32(1, 2, 3, 4);
        expect(rng1()).toBe(rng2());
        expect(rng1()).toBe(rng2());
    });

    it('produces different sequences with different seeds', () => {
        const rng1 = sfc32(1, 2, 3, 4);
        const rng2 = sfc32(9, 8, 7, 6);
        expect(rng1()).not.toBe(rng2());
    });
});

describe('cyrb128', () => {
    it('returns a 4-element array', () => {
        const result = cyrb128('hello');
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(4);
    });

    it('values are non-negative 32-bit integers', () => {
        const result = cyrb128('test');
        result.forEach(v => {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(0xFFFFFFFF);
            expect(Number.isInteger(v)).toBe(true);
        });
    });

    it('same string always produces same hash', () => {
        expect(cyrb128('hello')).toEqual(cyrb128('hello'));
        expect(cyrb128('test string')).toEqual(cyrb128('test string'));
    });

    it('different strings produce different hashes', () => {
        expect(cyrb128('hello')).not.toEqual(cyrb128('world'));
        expect(cyrb128('abc')).not.toEqual(cyrb128('def'));
    });

    it('handles empty string without throwing', () => {
        const result = cyrb128('');
        expect(result).toHaveLength(4);
    });
});

describe('generateUniqueColor', () => {
    it('returns rgb() format string', () => {
        const color = generateUniqueColor('test');
        expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    });

    it('is deterministic for the same string', () => {
        const c1 = generateUniqueColor('hello world');
        const c2 = generateUniqueColor('hello world');
        expect(c1).toBe(c2);
    });

    it('produces different colors for different strings', () => {
        const colors = new Set([
            generateUniqueColor('a'),
            generateUniqueColor('b'),
            generateUniqueColor('c'),
            generateUniqueColor('test'),
            generateUniqueColor('hello'),
            generateUniqueColor('world'),
        ]);
        expect(colors.size).toBeGreaterThan(3);
    });

    it('RGB values are in [0, 255] range', () => {
        const color = generateUniqueColor('test value');
        const match = color.match(/rgb\((\d+), (\d+), (\d+)\)/);
        expect(match).toBeTruthy();
        [1, 2, 3].forEach(i => {
            const v = parseInt(match[i]);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(255);
        });
    });

    it('null/undefined/empty falls back to Math.random (non-deterministic, still returns rgb)', () => {
        const c1 = generateUniqueColor(null);
        const c2 = generateUniqueColor(undefined);
        const c3 = generateUniqueColor('');
        expect(c1).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
        expect(c2).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
        expect(c3).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    });
});

describe('formatFileSize', () => {
    it('0 bytes returns 0b', () => {
        expect(formatFileSize(0)).toBe('0b');
    });

    it('bytes below 1024', () => {
        expect(formatFileSize(512)).toMatch(/^[\d.]+b$/);
    });

    it('kilobytes range', () => {
        expect(formatFileSize(1024)).toMatch(/^[\d.]+kb$/);
        expect(formatFileSize(2048)).toMatch(/^[\d.]+kb$/);
    });

    it('megabytes range', () => {
        expect(formatFileSize(1024 * 1024)).toMatch(/^[\d.]+mb$/);
    });

    it('gigabytes range', () => {
        expect(formatFileSize(1024 * 1024 * 1024)).toMatch(/^[\d.]+gb$/);
    });
});

describe('getCacheKey', () => {
    it('individual character key format', () => {
        const key = getCacheKey('avatar.png', false, null, 'alice');
        expect(key).toContain('char:');
        expect(key).toContain('avatar.png');
        expect(key).toContain('alice');
    });

    it('group key uses group: prefix', () => {
        const key = getCacheKey('group123', true, null, 'alice');
        expect(key).toContain('group:');
        expect(key).toContain('group123');
    });

    it('same params produce same key', () => {
        const settings = { nodeSep: 50, rankSep: 100 };
        const k1 = getCacheKey('avatar.png', false, settings, 'alice');
        const k2 = getCacheKey('avatar.png', false, settings, 'alice');
        expect(k1).toBe(k2);
    });

    it('different layout settings produce different keys', () => {
        const k1 = getCacheKey('avatar.png', false, { a: 1 }, 'alice');
        const k2 = getCacheKey('avatar.png', false, { a: 2 }, 'alice');
        expect(k1).not.toBe(k2);
    });

    it('different user handles produce different keys', () => {
        const k1 = getCacheKey('avatar.png', false, null, 'alice');
        const k2 = getCacheKey('avatar.png', false, null, 'bob');
        expect(k1).not.toBe(k2);
    });

    it('omitting userHandle is stable (defaults to empty string)', () => {
        const k1 = getCacheKey('avatar.png', false, null);
        const k2 = getCacheKey('avatar.png', false, null, '');
        expect(k1).toBe(k2);
    });
});

describe('isCacheValid', () => {
    it('fresh entry is valid', () => {
        const entry = { timestamp: Date.now() };
        expect(isCacheValid(entry)).toBe(true);
    });

    it('expired entry is invalid', () => {
        const entry = { timestamp: Date.now() - CACHE_TTL - 1000 };
        expect(isCacheValid(entry)).toBe(false);
    });

    it('null/undefined entry is invalid', () => {
        expect(isCacheValid(null)).toBeFalsy();
        expect(isCacheValid(undefined)).toBeFalsy();
    });

    it('entry exactly at TTL boundary is invalid', () => {
        const entry = { timestamp: Date.now() - CACHE_TTL };
        expect(isCacheValid(entry)).toBe(false);
    });
});

describe('resolveCacheTtlMs', () => {
    it('uses provided positive integer value', () => {
        expect(resolveCacheTtlMs('120000', DEFAULT_CACHE_TTL)).toBe(120000);
        expect(resolveCacheTtlMs(45000, DEFAULT_CACHE_TTL)).toBe(45000);
    });

    it('falls back when value is invalid or non-positive', () => {
        expect(resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL)).toBe(DEFAULT_CACHE_TTL);
        expect(resolveCacheTtlMs('not-a-number', DEFAULT_CACHE_TTL)).toBe(DEFAULT_CACHE_TTL);
        expect(resolveCacheTtlMs('0', DEFAULT_CACHE_TTL)).toBe(DEFAULT_CACHE_TTL);
        expect(resolveCacheTtlMs('-10', DEFAULT_CACHE_TTL)).toBe(DEFAULT_CACHE_TTL);
    });

    it('accepts values with leading/trailing spaces', () => {
        expect(resolveCacheTtlMs(' 60000 ', DEFAULT_CACHE_TTL)).toBe(60000);
    });

    it('exports a positive runtime TTL', () => {
        expect(CACHE_TTL).toBeGreaterThan(0);
    });
});
