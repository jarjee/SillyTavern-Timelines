function hasContextValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function normalizeGroupId(groupId) {
    if (!hasContextValue(groupId)) {
        return undefined;
    }
    return String(groupId);
}

function getCharacterAvatar(context) {
    if (!context || !hasContextValue(context.characterId)) {
        return undefined;
    }
    const characters = context.characters;
    if (!Array.isArray(characters)) {
        return undefined;
    }
    const character = characters[context.characterId];
    return character?.avatar;
}

export function getTimelineContextDescriptor(context) {
    if (!context) {
        return {
            kind: 'none',
            key: null,
            isGroupChat: false,
            groupId: undefined,
            avatarUrl: undefined,
        };
    }

    const avatarUrl = getCharacterAvatar(context);
    const groupId = normalizeGroupId(context.groupId);
    if (groupId !== undefined) {
        return {
            kind: 'group',
            key: `group:${groupId}`,
            isGroupChat: true,
            groupId,
            avatarUrl,
        };
    }

    if (avatarUrl) {
        return {
            kind: 'character',
            key: `char:${avatarUrl}`,
            isGroupChat: false,
            groupId: undefined,
            avatarUrl,
        };
    }

    if (hasContextValue(context.characterId)) {
        const characterId = String(context.characterId);
        return {
            kind: 'character',
            key: `char-id:${characterId}`,
            isGroupChat: false,
            groupId: undefined,
            avatarUrl: undefined,
        };
    }

    return {
        kind: 'none',
        key: null,
        isGroupChat: false,
        groupId: undefined,
        avatarUrl: undefined,
    };
}

export function shouldRefreshTimelineData(lastContextKey, nextContextKey, isInvalidated) {
    if (!nextContextKey) {
        return false;
    }
    if (isInvalidated) {
        return true;
    }
    return lastContextKey !== nextContextKey;
}

export function normalizeGraphDirection(graphDirection) {
    if (graphDirection === 'LR' || graphDirection === 'TB') {
        return graphDirection;
    }
    return 'auto';
}

export function resolveGraphDirection(graphDirection, viewportWidth, viewportHeight) {
    const normalizedDirection = normalizeGraphDirection(graphDirection);
    if (normalizedDirection !== 'auto') {
        return normalizedDirection;
    }

    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) {
        return 'LR';
    }
    return viewportWidth > viewportHeight ? 'LR' : 'TB';
}
