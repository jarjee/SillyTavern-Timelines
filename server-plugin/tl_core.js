/**
 * Core data processing functions for Timeline extension
 * Shared between client and server implementations
 */

/**
 * Seedable RNG from PractRand suite
 * @param {number} a - Seed component 1
 * @param {number} b - Seed component 2
 * @param {number} c - Seed component 3
 * @param {number} d - Seed component 4
 * @returns {Function} Random number generator
 */
export function sfc32(a, b, c, d) {
    return function() {
        a |= 0; b |= 0; c |= 0; d |= 0;
        var t = (a + b | 0) + d | 0;
        d = d + 1 | 0;
        a = b ^ b >>> 9;
        b = c + (c << 3) | 0;
        c = (c << 21 | c >>> 11);
        c = c + t | 0;
        return (t >>> 0) / 4294967296;
    }
}

/**
 * 128-bit hash function for RNG seeding
 * @param {string} str - String to hash
 * @returns {Array<number>} 4-element array of 32-bit values
 */
export function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277,
        h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
        k = str.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4), h2 ^= h1, h3 ^= h1, h4 ^= h1;
    return [h1>>>0, h2>>>0, h3>>>0, h4>>>0];
}

/**
 * Generate deterministic color from string
 * @param {string} str - Input string
 * @returns {string} RGB color string
 */
export function generateUniqueColor(str) {
    let random;
    if (str) {
        let seed = cyrb128(str);
        random = sfc32(seed[0], seed[1], seed[2], seed[3]);
    } else {
        random = Math.random;
    }

    const randomRGBValue = () => Math.floor(random() * 256);
    return `rgb(${randomRGBValue()}, ${randomRGBValue()}, ${randomRGBValue()})`;
}

/**
 * Normalize message text (newlines, whitespace)
 * Optimized version with memoization
 */
const normalizeCache = new Map();
const NORMALIZE_CACHE_SIZE = 1000;

export function normalizeMessageText(text) {
    if (normalizeCache.has(text)) {
        return normalizeCache.get(text);
    }

    const normalized = text.replace(/\r\n/g, '\n');

    // Simple LRU: clear cache if too large
    if (normalizeCache.size >= NORMALIZE_CACHE_SIZE) {
        const firstKey = normalizeCache.keys().next().value;
        normalizeCache.delete(firstKey);
    }

    normalizeCache.set(text, normalized);
    return normalized;
}

/**
 * Transpose chats from file-based to depth-based structure
 * @param {Object} channelHistory - {file_name: [messages]}
 * @returns {Array} Transposed structure
 */
export function preprocessChatSessions(channelHistory) {
    const allChats = [];

    for (const [file_name, messages] of Object.entries(channelHistory)) {
        messages.forEach((message, index) => {
            if (!allChats[index]) {
                allChats[index] = [];
            }
            allChats[index].push({
                file_name,
                index,
                message,
            });
        });
    }

    return allChats;
}

/**
 * Group messages by exact text content
 * Optimized version using Map for better performance
 * @param {Array} messages - Messages at same depth
 * @returns {Object} Grouped messages
 */
export function groupMessagesByContent(messages) {
    const groups = new Map();

    for (let i = 0; i < messages.length; i++) {
        const messageObj = messages[i];
        const { file_name, message } = messageObj;

        try {
            // Normalize newlines using cached function
            const normalizedText = normalizeMessageText(message.mes);

            if (!groups.has(normalizedText)) {
                groups.set(normalizedText, []);
            }

            groups.get(normalizedText).push({
                file_name,
                index: i,
                message: { ...message, mes: normalizedText }
            });
        } catch (e) {
            console.error(`Message Grouping Error: ${e}: ${JSON.stringify(message, null, 4)}`);
        }
    }

    // Convert Map to Object for compatibility
    const result = {};
    for (const [key, value] of groups.entries()) {
        result[key] = value;
    }

    return result;
}

/**
 * Create a node with metadata
 * @param {string} nodeId - Node ID
 * @param {number} messageId - Message depth
 * @param {string} text - Message text
 * @param {Array} group - Messages with same content
 * @param {Object} allChatFileNamesAndLengths - Chat lengths
 * @returns {Object} Node data
 */
export function createNode(nodeId, messageId, text, group, allChatFileNamesAndLengths) {
    let bookmark = group.find(({ message }) => {
        // Legacy format (pre-summer 2023)
        if (message.is_system && message.mes.includes('Bookmark created! Click here to open the bookmark chat')) {
            return true;
        }
        // Current format
        return !!message.extra && !!message.extra.bookmark_link;
    });

    let isBookmark = Boolean(bookmark);

    let bookmarkName, fileNameForNode;
    if (isBookmark) {
        if (bookmark.message.extra && bookmark.message.extra.bookmark_link) {
            bookmarkName = bookmark.message.extra.bookmark_link;
            fileNameForNode = bookmark.file_name;
        } else {
            // Extract from legacy anchor tag
            let match = bookmark.message.mes.match(/file_name=\"(.*?)\"/);
            bookmarkName = match ? match[1] : null;
            fileNameForNode = bookmarkName;
        }
    } else {
        fileNameForNode = group[0].file_name;
    }

    // Omit dead checkpoint links
    if (isBookmark && !allChatFileNamesAndLengths.hasOwnProperty(`${bookmarkName}.jsonl`)) {
        console.info(`[timelines] Omitting dead link to '${bookmarkName}'`);
        isBookmark = false;
        bookmarkName = undefined;
        fileNameForNode = undefined;
    }

    const { is_name, is_user, name, send_date, is_system } = group[0].message;

    // Map chat sessions containing this message
    const chat_sessions = {};
    for (const {file_name, index} of group) {
        chat_sessions[file_name] = {
            messageId: messageId,
            indexInGroup: index,
            length: allChatFileNamesAndLengths[file_name],
        };
    }

    return {
        id: nodeId,
        msg: text,
        chat_depth: messageId,
        isBookmark: isBookmark,
        bookmarkName: bookmarkName,
        file_name: fileNameForNode,
        is_name: is_name,
        is_user: is_user,
        is_system: is_system,
        name: name,
        send_date: send_date,
        color: isBookmark ? generateUniqueColor(text) : null,
        chat_sessions: chat_sessions,
    };
}

/**
 * Build DAG from preprocessed chats
 * @param {Array} allChats - Transposed chat structure
 * @param {Object} allChatFileNamesAndLengths - Chat lengths
 * @param {Object} options - Additional options (e.g., for caching)
 * @returns {Object} { elements: Array, swipeData: Object }
 */
export function buildGraph(allChats, allChatFileNamesAndLengths, options = {}) {
    const cyElements = [];
    let keyCounter = 1;
    const previousNodes = {};
    const parentSwipeData = {};

    // Gather AI character names for root node
    const characterNames = new Set();
    for (let messageId = 0; messageId < allChats.length; messageId++) {
        const messages = allChats[messageId];
        for (let i = 0; i < messages.length; i++) {
            const { message } = messages[i];
            if (!message.is_user && !message.is_system) {
                characterNames.add(message.name);
            }
        }
    }
    const rootNodeName = [...characterNames].sort().join(', ');

    // Create root node
    cyElements.push({
        group: 'nodes',
        data: {
            id: 'root',
            label: 'root',
            name: rootNodeName,
            send_date: '',
            x: 0,
            y: 0,
        },
    });

    // Initialize previousNodes
    if (allChats.length > 0) {
        allChats[0].forEach(({ file_name }) => {
            previousNodes[file_name] = 'root';
        });
    }

    // Process each message depth
    for (let messageId = 0; messageId < allChats.length; messageId++) {
        const groups = groupMessagesByContent(allChats[messageId]);

        for (const [text, group] of Object.entries(groups)) {
            const nodeId = `message${keyCounter}`;
            const node = createNode(nodeId, messageId, text, group, allChatFileNamesAndLengths);

            // Extract swipes (skip greeting messages at index 0)
            const allSwipes = [];
            let uniqueSwipes = [];
            if (messageId !== 0) {
                for (let i = 0; i < group.length; i++) {
                    const swipes = group[i].message.swipes || [];
                    allSwipes.push(...swipes);
                }
                uniqueSwipes = [...new Set(allSwipes)].filter(swipeText => swipeText !== text);
            }

            // Process each message in the group
            const uniqueParents = new Set();
            for (const messageObj of group) {
                const parentNodeId = previousNodes[messageObj.file_name];

                // Store swipe data for each unique parent
                if (messageId !== 0 && !uniqueParents.has(parentNodeId)) {
                    uniqueParents.add(parentNodeId);

                    if (!parentSwipeData[parentNodeId]) {
                        parentSwipeData[parentNodeId] = {
                            storedSwipes: [],
                            totalSwipes: 0,
                            currentSwipeIndex: uniqueSwipes.indexOf(text),
                        };
                    }

                    parentSwipeData[parentNodeId].totalSwipes += uniqueSwipes.length;

                    // Create swipe nodes and edges
                    for (let i = 0; i < uniqueSwipes.length; i++) {
                        const swipeText = uniqueSwipes[i];
                        const swipeNodeId = `swipe${keyCounter}-${parentSwipeData[parentNodeId].totalSwipes}`;
                        const swipeIndex = allSwipes.indexOf(swipeText);
                        const swipeNode = {
                            ...node,
                            id: swipeNodeId,
                            msg: swipeText,
                            isSwipe: true,
                            swipeId: swipeIndex,
                        };
                        delete swipeNode.swipes;

                        const swipeEdge = {
                            id: `edgeSwipe${keyCounter}`,
                            source: parentNodeId,
                            target: swipeNodeId,
                            isSwipe: true,
                            swipeId: swipeIndex,
                        };

                        parentSwipeData[parentNodeId].storedSwipes.push({ node: swipeNode, edge: swipeEdge });
                        keyCounter += 1;
                    }
                }

                cyElements.push({
                    group: 'nodes',
                    data: node,
                });

                cyElements.push({
                    group: 'edges',
                    data: {
                        id: `edge${keyCounter}`,
                        source: parentNodeId,
                        target: nodeId,
                    },
                });

                previousNodes[messageObj.file_name] = nodeId;
                keyCounter += 1;
            }
        }
    }

    // Attach swipe data to parent nodes
    for (let i = 0; i < cyElements.length; i++) {
        const element = cyElements[i];
        if (element.group === 'nodes' && parentSwipeData[element.data.id]) {
            Object.assign(element.data, parentSwipeData[element.data.id]);
        }
    }

    return {
        elements: cyElements,
        swipeData: parentSwipeData
    };
}

/**
 * Highlight checkpoint paths
 * @param {Array} rawData - Cytoscape elements
 * @returns {Array} Modified elements
 */
export function highlightCheckpointPaths(rawData) {
    // Find all checkpoint nodes
    const bookmarkNodes = rawData.filter(entry =>
        entry.group === 'nodes' && entry.data.isBookmark
    );

    // Highlight path from each checkpoint to root
    for (let i = 0; i < bookmarkNodes.length; i++) {
        const bookmarkNode = bookmarkNodes[i];
        let currentNode = bookmarkNode;
        let currentZIndex = 1000;
        let currentHighlightThickness = 4;

        while (currentNode) {
            // Stop if we hit another checkpoint
            if (currentNode !== bookmarkNode && currentNode.data.isBookmark) {
                break;
            }

            // Find incoming edge
            let incomingEdge = rawData.find(entry =>
                entry.group === 'edges' && entry.data.target === currentNode.data.id
            );

            if (incomingEdge) {
                // Color the edge
                incomingEdge.data.isHighlight = true;
                incomingEdge.data.color = bookmarkNode.data.color;
                incomingEdge.data.bookmarkName = bookmarkNode.data.bookmarkName;
                incomingEdge.data.highlightThickness = currentHighlightThickness;
                currentHighlightThickness = Math.min(currentHighlightThickness + 0.1, 6);

                // Color the node border
                currentNode.data.borderColor = incomingEdge.data.color;

                // Adjust z-index for layering
                incomingEdge.data.zIndex = currentZIndex;
                currentZIndex++;

                // Move to parent node
                currentNode = rawData.find(entry =>
                    entry.group === 'nodes' && entry.data.id === incomingEdge.data.source
                );
            } else {
                currentNode = null; // Reached root
            }
        }
    }

    return rawData;
}

/**
 * Convert chat history to Cytoscape elements
 * @param {Object} chatHistory - {file_name: [messages]}
 * @param {Object} options - Additional options
 * @returns {Object} { elements: Array, swipeData: Object }
 */
export function convertToCytoscapeElements(chatHistory, options = {}) {
    const allChats = preprocessChatSessions(chatHistory);

    // Get chat lengths
    const allChatFileNamesAndLengths = {};
    for (const [key, val] of Object.entries(chatHistory)) {
        allChatFileNamesAndLengths[key] = val.length;
    }

    const { elements, swipeData } = buildGraph(allChats, allChatFileNamesAndLengths, options);
    const highlightedElements = highlightCheckpointPaths(elements);

    return {
        elements: highlightedElements,
        swipeData: swipeData
    };
}
