function normalizeMessageText(text) {
    return String(text ?? '').replace(/\r\n/g, '\n');
}

function isNodeElement(element) {
    return element?.group === 'nodes' && element?.data && typeof element.data.id === 'string';
}

function isEdgeElement(element) {
    return element?.group === 'edges' && element?.data;
}

function getNodeElements(graphElements) {
    return graphElements.filter(isNodeElement);
}

function getEdgeElements(graphElements) {
    return graphElements.filter(isEdgeElement);
}

function collectSessionFileNames(graphElements) {
    const names = new Set();
    for (const node of getNodeElements(graphElements)) {
        const sessions = node.data.chat_sessions;
        if (!sessions || typeof sessions !== 'object') {
            continue;
        }
        for (const fileName of Object.keys(sessions)) {
            names.add(fileName);
        }
    }
    return names;
}

function collectSessionLengths(graphElements) {
    const lengths = new Map();
    for (const node of getNodeElements(graphElements)) {
        const sessions = node.data.chat_sessions;
        if (!sessions || typeof sessions !== 'object') {
            continue;
        }
        for (const [fileName, metadata] of Object.entries(sessions)) {
            const lengthField = Number(metadata?.length);
            const depthField = Number(metadata?.messageId);
            const inferredLength = Number.isInteger(depthField) ? depthField + 1 : 0;
            const length = Number.isInteger(lengthField) && lengthField > 0 ? lengthField : inferredLength;
            const prev = lengths.get(fileName) ?? 0;
            if (length > prev) {
                lengths.set(fileName, length);
            }
        }
    }
    return lengths;
}

function findRootNode(graphElements) {
    return getNodeElements(graphElements).find(node => node.data.id === 'root');
}

function findNodeByFileAndDepth(graphElements, fileName, depth) {
    return getNodeElements(graphElements).find(node => {
        if (node.data.isSwipe) {
            return false;
        }
        const sessions = node.data.chat_sessions;
        if (!sessions || !sessions[fileName]) {
            return false;
        }
        return Number(sessions[fileName].messageId) === depth;
    });
}

function findNodeByDepthAndText(graphElements, depth, text) {
    return getNodeElements(graphElements).find(node => {
        if (node.data.isSwipe) {
            return false;
        }
        return Number(node.data.chat_depth) === depth && normalizeMessageText(node.data.msg) === text;
    });
}

function hasEdge(graphElements, sourceId, targetId) {
    return getEdgeElements(graphElements).some(edge => edge.data.source === sourceId && edge.data.target === targetId);
}

function nextSequentialId(graphElements, prefix) {
    let maxId = 0;
    const pattern = new RegExp(`^${prefix}(\\d+)$`);
    for (const element of graphElements) {
        const id = element?.data?.id;
        if (typeof id !== 'string') {
            continue;
        }
        const match = id.match(pattern);
        if (!match) {
            continue;
        }
        const value = Number.parseInt(match[1], 10);
        if (Number.isInteger(value) && value > maxId) {
            maxId = value;
        }
    }
    return `${prefix}${maxId + 1}`;
}

function updateSessionLengthForFile(graphElements, fileName, newLength) {
    const touchedNodeIds = [];
    for (const node of getNodeElements(graphElements)) {
        const sessions = node.data.chat_sessions;
        if (!sessions || !sessions[fileName]) {
            continue;
        }
        sessions[fileName].length = newLength;
        touchedNodeIds.push(node.data.id);
    }
    return touchedNodeIds;
}

function getParentPosition(parentNode) {
    if (!parentNode || !parentNode.position) {
        return null;
    }
    const { x, y } = parentNode.position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    return { x, y };
}

function inferNodePosition(parentNode, rankDir, rankStep) {
    const parentPosition = getParentPosition(parentNode);
    if (!parentPosition) {
        return null;
    }
    const step = Number.isFinite(rankStep) && rankStep > 0 ? rankStep : 80;
    if (rankDir === 'TB') {
        return { x: parentPosition.x, y: parentPosition.y + step };
    }
    return { x: parentPosition.x + step, y: parentPosition.y };
}

function hasUnsupportedBookmarkData(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    if (message.extra?.bookmark_link) {
        return true;
    }
    if (message.is_system && typeof message.mes === 'string' && message.mes.includes('Bookmark created! Click here to open the bookmark chat')) {
        return true;
    }
    return false;
}

function hasUnsupportedAltSwipes(message, text) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    const normalizedAlternatives = [...new Set(swipes
        .map(swipe => normalizeMessageText(swipe))
        .filter(swipe => swipe && swipe !== text))];
    return normalizedAlternatives.length > 0;
}

export function resolveTimelineChatFileName(chatId, graphElements) {
    const fileNames = collectSessionFileNames(graphElements);
    if (fileNames.size === 0) {
        return null;
    }

    const rawChatId = (chatId === null || chatId === undefined) ? '' : String(chatId);
    if (rawChatId) {
        if (fileNames.has(rawChatId)) {
            return rawChatId;
        }
        const withExtension = rawChatId.endsWith('.jsonl') ? rawChatId : `${rawChatId}.jsonl`;
        if (fileNames.has(withExtension)) {
            return withExtension;
        }
    }

    if (fileNames.size === 1) {
        return [...fileNames][0];
    }

    return null;
}

/**
 * Attempts an append-only incremental update of timeline graph elements.
 *
 * The update is intentionally conservative. If it detects any unsupported condition,
 * it returns `applied: false` and callers should fall back to a full rebuild.
 *
 * @param {Object} options - Update options.
 * @param {Array<Object>} options.graphElements - Existing Cytoscape elements.
 * @param {Object} options.message - New chat message object from current context.
 * @param {number} options.messageId - Message depth index in the chat session.
 * @param {string} options.fileName - Current chat file name (with `.jsonl` extension).
 * @param {string} [options.rankDir='LR'] - Preferred rank direction (`LR` or `TB`) for inferred positions.
 * @param {number} [options.rankStep=80] - Position delta for inferred node placement.
 * @returns {Object} Update result.
 */
export function applyIncrementalMessageUpdate(options) {
    const {
        graphElements,
        message,
        messageId,
        fileName,
        rankDir = 'LR',
        rankStep = 80,
    } = options;

    if (!Array.isArray(graphElements) || !fileName || !Number.isInteger(messageId) || messageId < 0) {
        return { applied: false, reason: 'invalid_input' };
    }
    if (!message || typeof message.mes !== 'string') {
        return { applied: false, reason: 'invalid_message' };
    }

    if (hasUnsupportedBookmarkData(message)) {
        return { applied: false, reason: 'unsupported_bookmark' };
    }

    const normalizedText = normalizeMessageText(message.mes);
    if (hasUnsupportedAltSwipes(message, normalizedText)) {
        return { applied: false, reason: 'unsupported_swipes' };
    }

    const lengths = collectSessionLengths(graphElements);
    const currentLength = lengths.get(fileName) ?? 0;
    if (messageId !== currentLength) {
        return { applied: false, reason: 'non_append' };
    }

    const parentNode = (messageId === 0)
        ? findRootNode(graphElements)
        : findNodeByFileAndDepth(graphElements, fileName, messageId - 1);

    if (!parentNode) {
        return { applied: false, reason: 'missing_parent' };
    }

    const newLength = messageId + 1;
    const touchedNodeIds = updateSessionLengthForFile(graphElements, fileName, newLength);
    const parentId = parentNode.data.id;

    const existingNode = findNodeByDepthAndText(graphElements, messageId, normalizedText);
    const addedElements = [];

    if (existingNode) {
        if (!existingNode.data.chat_sessions || typeof existingNode.data.chat_sessions !== 'object') {
            existingNode.data.chat_sessions = {};
        }
        existingNode.data.chat_sessions[fileName] = {
            messageId,
            indexInGroup: 0,
            length: newLength,
        };

        if (!hasEdge(graphElements, parentId, existingNode.data.id)) {
            const edgeElement = {
                group: 'edges',
                data: {
                    id: nextSequentialId(graphElements, 'edge'),
                    source: parentId,
                    target: existingNode.data.id,
                },
            };
            graphElements.push(edgeElement);
            addedElements.push(edgeElement);
        }

        return {
            applied: true,
            reason: 'updated_existing_node',
            graphElements,
            addedElements,
            touchedNodeIds: [...new Set([...touchedNodeIds, existingNode.data.id])],
            requiresRelayout: false,
        };
    }

    const newNodeId = nextSequentialId(graphElements, 'message');
    const nodeElement = {
        group: 'nodes',
        data: {
            id: newNodeId,
            msg: normalizedText,
            chat_depth: messageId,
            isBookmark: false,
            bookmarkName: undefined,
            file_name: fileName,
            is_name: message.is_name,
            is_user: message.is_user,
            is_system: message.is_system,
            name: message.name,
            send_date: message.send_date,
            color: null,
            chat_sessions: {
                [fileName]: {
                    messageId,
                    indexInGroup: 0,
                    length: newLength,
                },
            },
        },
    };

    const inferredPosition = inferNodePosition(parentNode, rankDir, rankStep);
    if (inferredPosition) {
        nodeElement.position = inferredPosition;
    }

    const edgeElement = {
        group: 'edges',
        data: {
            id: nextSequentialId(graphElements, 'edge'),
            source: parentId,
            target: newNodeId,
        },
    };

    graphElements.push(nodeElement, edgeElement);
    addedElements.push(nodeElement, edgeElement);

    return {
        applied: true,
        reason: 'added_new_node',
        graphElements,
        addedElements,
        touchedNodeIds,
        requiresRelayout: !inferredPosition,
    };
}

export const _testExports = {
    normalizeMessageText,
    collectSessionFileNames,
    collectSessionLengths,
    nextSequentialId,
    hasUnsupportedAltSwipes,
};
