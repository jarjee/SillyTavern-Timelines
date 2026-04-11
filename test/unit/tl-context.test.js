import { describe, expect, it } from 'vitest';
import {
    getTimelineContextDescriptor,
    normalizeGraphDirection,
    resolveGraphDirection,
    shouldRefreshTimelineData,
} from '../../tl_context.js';

describe('getTimelineContextDescriptor', () => {
    it('treats group context as primary identity', () => {
        const descriptor = getTimelineContextDescriptor({
            groupId: 'group-42',
            characterId: 0,
            characters: [{ avatar: 'alice.png' }],
        });

        expect(descriptor.kind).toBe('group');
        expect(descriptor.isGroupChat).toBe(true);
        expect(descriptor.key).toBe('group:group-42');
        expect(descriptor.avatarUrl).toBe('alice.png');
    });

    it('uses character avatar as stable key when available', () => {
        const descriptor = getTimelineContextDescriptor({
            groupId: null,
            characterId: 0,
            characters: [{ avatar: 'alice.png' }],
        });

        expect(descriptor.kind).toBe('character');
        expect(descriptor.isGroupChat).toBe(false);
        expect(descriptor.key).toBe('char:alice.png');
        expect(descriptor.avatarUrl).toBe('alice.png');
    });

    it('falls back to character id key when avatar is missing', () => {
        const descriptor = getTimelineContextDescriptor({
            groupId: null,
            characterId: 7,
            characters: [],
        });

        expect(descriptor.kind).toBe('character');
        expect(descriptor.key).toBe('char-id:7');
    });

    it('returns none when context has no usable identity', () => {
        const descriptor = getTimelineContextDescriptor({
            groupId: null,
            characterId: null,
            characters: [],
        });

        expect(descriptor.kind).toBe('none');
        expect(descriptor.key).toBeNull();
    });
});

describe('shouldRefreshTimelineData', () => {
    it('does not refresh when context key is unchanged and data is not invalidated', () => {
        expect(shouldRefreshTimelineData('char:alice.png', 'char:alice.png', false)).toBe(false);
    });

    it('refreshes when context key changes', () => {
        expect(shouldRefreshTimelineData('char:alice.png', 'char:bob.png', false)).toBe(true);
    });

    it('refreshes when data is invalidated even if key is unchanged', () => {
        expect(shouldRefreshTimelineData('char:alice.png', 'char:alice.png', true)).toBe(true);
    });
});

describe('graph direction helpers', () => {
    it('normalizes unsupported direction values to auto', () => {
        expect(normalizeGraphDirection('LR')).toBe('LR');
        expect(normalizeGraphDirection('TB')).toBe('TB');
        expect(normalizeGraphDirection('anything-else')).toBe('auto');
    });

    it('resolves auto direction from viewport shape', () => {
        expect(resolveGraphDirection('auto', 1200, 800)).toBe('LR');
        expect(resolveGraphDirection('auto', 800, 1200)).toBe('TB');
    });

    it('resolves explicit direction without viewport checks', () => {
        expect(resolveGraphDirection('LR', 1, 9999)).toBe('LR');
        expect(resolveGraphDirection('TB', 9999, 1)).toBe('TB');
    });

    it('falls back to LR when auto direction has no viewport info', () => {
        expect(resolveGraphDirection('auto', undefined, undefined)).toBe('LR');
    });
});
