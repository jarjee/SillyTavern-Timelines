import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Response cache with TTL (Time To Live)
 * Stores cached responses for quick repeated requests
 */
const responseCache = new Map();
const swipeCache = new Map();
const CACHE_TTL = 30000; // 30 seconds in milliseconds

/**
 * Get or create cache key for a character/group combination
 * @param {string} characterId - Avatar URL (for individual) or group ID
 * @param {boolean} isGroup - Whether this is a group chat
 * @returns {string} Cache key
 */
function getCacheKey(characterId, isGroup) {
    return `${isGroup ? 'group' : 'char'}:${characterId}`;
}

/**
 * Check if cache entry is still valid
 * @param {Object} entry - Cache entry with timestamp
 * @returns {boolean} True if entry is valid
 */
function isCacheValid(entry) {
    return entry && Date.now() - entry.timestamp < CACHE_TTL;
}

/**
 * Check if a file or directory exists
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>} True if exists
 */
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Get the appropriate chat directory path
 * Supports both single-user and multi-user SillyTavern setups
 * @param {string} avatar_url - The character avatar filename
 * @param {boolean} is_group - Whether this is a group chat
 * @returns {Promise<string>} Path to the chat directory
 */
async function resolveChatDirectory(avatar_url, is_group) {
    const serverRoot = path.resolve(__dirname, '../../');
    const dataDir = path.join(serverRoot, 'data');

    let userDir = 'default-user';

    try {
        if (await fileExists(dataDir)) {
            const entries = await fs.readdir(dataDir, { withFileTypes: true });
            const userDirs = entries
                .filter(entry => entry.isDirectory())
                .filter(entry => !entry.name.startsWith('_'))
                .filter(entry => !entry.name.startsWith('.'));

            if (userDirs.length > 0) {
                userDir = userDirs[0].name;
            }
        }
    } catch (e) {
        console.warn('[timelines-data] Could not read user directories:', e.message);
    }

    const chatsBaseDir = path.join(dataDir, userDir, 'chats');

    if (is_group) {
        return path.join(chatsBaseDir, 'group_chats');
    } else {
        const characterName = String(avatar_url).replace('.png', '').replace('.jpg', '').replace('.jpeg', '');
        return path.join(chatsBaseDir, characterName);
    }
}

/**
 * Format file size in human-readable format
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0b';
    const k = 1024;
    const sizes = ['b', 'kb', 'mb', 'gb'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + sizes[i];
}

// ============================================================================
// GRAPH BUILDING FUNCTIONS (Ported from frontend)
// ============================================================================

/**
 * Seedable RNG from PractRand suite
 * @param {number} a - Seed component 1
 * @param {number} b - Seed component 2
 * @param {number} c - Seed component 3
 * @param {number} d - Seed component 4
 * @returns {Function} Random number generator
 */
function sfc32(a, b, c, d) {
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
function cyrb128(str) {
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
function generateUniqueColor(str) {
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
 * Transpose chats from file-based to depth-based structure
 * @param {Object} channelHistory - {file_name: [messages]}
 * @returns {Array} Transposed structure
 */
function preprocessChatSessions(channelHistory) {
    let allChats = [];

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
 * @param {Array} messages - Messages at same depth
 * @returns {Object} Grouped messages
 */
function groupMessagesByContent(messages) {
    let groups = {};
    messages.forEach((messageObj, index) => {
        let { file_name, message } = messageObj;
        try {
            // Normalize newlines
            message.mes = message.mes.replace(/\r\n/g, '\n');
            if (!groups[message.mes]) {
                groups[message.mes] = [];
            }
            groups[message.mes].push({ file_name, index, message });
        } catch (e) {
            console.error(`[timelines-data] Message Grouping Error: ${e}: ${JSON.stringify(message, null, 4)}`);
        }
    });
    return groups;
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
function createNode(nodeId, messageId, text, group, allChatFileNamesAndLengths) {
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
        console.info(`[timelines-data] Omitting dead link to '${bookmarkName}'`);
        isBookmark = false;
        bookmarkName = undefined;
        fileNameForNode = undefined;
    }

    let { is_name, is_user, name, send_date, is_system } = group[0].message;

    // Map chat sessions containing this message
    let chat_sessions = {};
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
 * @param {string} cacheKey - Key for swipe storage
 * @returns {Array} Cytoscape elements
 */
function buildGraph(allChats, allChatFileNamesAndLengths, cacheKey) {
    let cyElements = [];
    let keyCounter = 1;
    let previousNodes = {};
    let parentSwipeData = {};

    // Gather AI character names for root node
    let characterNames = new Set();
    for (let messageId = 0; messageId < allChats.length; messageId++) {
        const messages = allChats[messageId];
        messages.forEach((messageObj) => {
            const { message } = messageObj;
            if (!message.is_user && !message.is_system) {
                characterNames.add(message.name);
            }
        });
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
    allChats[0].forEach(({ file_name }) => {
        previousNodes[file_name] = 'root';
    });

    // Process each message depth
    for (let messageId = 0; messageId < allChats.length; messageId++) {
        let groups = groupMessagesByContent(allChats[messageId]);

        for (const [text, group] of Object.entries(groups)) {
            const nodeId = `message${keyCounter}`;
            const node = createNode(nodeId, messageId, text, group, allChatFileNamesAndLengths);

            // Extract swipes (skip greeting messages at index 0)
            const allSwipes = [];
            let uniqueSwipes = [];
            if (messageId !== 0) {
                group.forEach(messageObj => {
                    const swipes = messageObj.message.swipes || [];
                    allSwipes.push(...swipes);
                });
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
                    uniqueSwipes.forEach(swipeText => {
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
                    });
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
    cyElements.forEach(element => {
        if (element.group === 'nodes' && parentSwipeData[element.data.id]) {
            Object.assign(element.data, parentSwipeData[element.data.id]);
        }
    });

    // Store swipes in cache for lazy loading
    swipeCache.set(cacheKey, {
        data: parentSwipeData,
        timestamp: Date.now()
    });

    return cyElements;
}

/**
 * Highlight checkpoint paths
 * @param {Array} rawData - Cytoscape elements
 * @returns {Array} Modified elements
 */
function highlightCheckpointPaths(rawData) {
    // Find all checkpoint nodes
    const bookmarkNodes = rawData.filter(entry =>
        entry.group === 'nodes' && entry.data.isBookmark
    );

    // Highlight path from each checkpoint to root
    bookmarkNodes.forEach(bookmarkNode => {
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
    });

    return rawData;
}

/**
 * Convert chat history to Cytoscape elements
 * @param {Object} chatHistory - {file_name: [messages]}
 * @param {string} cacheKey - Key for swipe cache
 * @returns {Array} Cytoscape elements
 */
function convertToCytoscapeElements(chatHistory, cacheKey) {
    let allChats = preprocessChatSessions(chatHistory);

    // Get chat lengths
    let allChatFileNamesAndLengths = {};
    for (const [key, val] of Object.entries(chatHistory)) {
        allChatFileNamesAndLengths[key] = val.length;
    }

    let elements = buildGraph(allChats, allChatFileNamesAndLengths, cacheKey);
    elements = highlightCheckpointPaths(elements);
    return elements;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Initialize plugin with Express router
 * @param {import('express').Router} router - Express router instance
 * @returns {Promise<void>}
 */
async function init(router) {
    /**
     * Bulk fetch endpoint with server-side graph building
     * POST /api/plugins/timelines-data/bulk-fetch
     */
    router.post('/bulk-fetch', async (req, res) => {
        try {
            const { avatar_url, is_group = false } = req.body;

            if (!avatar_url) {
                return res.status(400).json({
                    error: 'Missing required field: avatar_url'
                });
            }

            const cacheKey = getCacheKey(avatar_url, is_group);

            // Check cache first
            const cached = responseCache.get(cacheKey);
            if (isCacheValid(cached)) {
                return res.json(cached.data);
            }

            // Resolve chat directory
            const chatDirectory = await resolveChatDirectory(avatar_url, is_group);

            const result = {
                chats: {},
                metadata: {}
            };

            // Check if directory exists
            if (!(await fileExists(chatDirectory))) {
                console.warn('[timelines-data] Chat directory does not exist:', chatDirectory);
                return res.json(result);
            }

            // Read directory of chats
            const files = await fs.readdir(chatDirectory, { withFileTypes: true });
            const chatFiles = files
                .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
                .sort((a, b) => b.name.localeCompare(a.name));

            // Fetch all chats in parallel
            await Promise.all(chatFiles.map(async (file) => {
                try {
                    const chatPath = path.join(chatDirectory, file.name);
                    const content = await fs.readFile(chatPath, 'utf8');
                    const lines = content.trim().split('\n').filter(line => line.length > 0);

                    // Parse chat messages
                    const messages = lines.map((line, index) => {
                        try {
                            return JSON.parse(line);
                        } catch (e) {
                            console.error(`Failed to parse line ${index} in ${file.name}:`, e.message);
                            return null;
                        }
                    }).filter(msg => msg !== null);

                    // Remove metadata line for individual chats
                    if (!is_group && messages.length > 0 && (!messages[0].mes || messages[0].chat_metadata)) {
                        messages.shift();
                    }

                    result.chats[file.name] = messages;

                    // Get file stats for metadata
                    const stat = await fs.stat(chatPath);
                    const messageCount = messages.length;
                    const lastMessage = messages[messages.length - 1];

                    result.metadata[file.name] = {
                        file_size: formatFileSize(stat.size),
                        chat_items: messageCount,
                        mes: lastMessage ? lastMessage.mes : '',
                        last_mes: lastMessage ? lastMessage.send_date : stat.mtimeMs
                    };
                } catch (e) {
                    console.error(`Error reading chat ${file.name}:`, e.message);
                }
            }));

            // Build graph server-side
            const graphElements = convertToCytoscapeElements(result.chats, cacheKey);

            // Strip swipes from response to reduce size - they'll be lazy-loaded via /swipes/:nodeId
            graphElements.forEach(element => {
                if (element.group === 'nodes' && element.data.storedSwipes) {
                    delete element.data.storedSwipes;
                    // Keep totalSwipes and currentSwipeIndex for UI
                }
            });

            const response = {
                graph: graphElements,
                metadata: result.metadata
            };

            // Cache the response
            responseCache.set(cacheKey, {
                data: response,
                timestamp: Date.now()
            });

            res.json(response);
        } catch (error) {
            console.error('[timelines-data] Error in bulk-fetch endpoint:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    /**
     * Lazy-load swipes for a specific node
     * GET /api/plugins/timelines-data/swipes/:nodeId
     */
    router.get('/swipes/:nodeId', (req, res) => {
        try {
            const { nodeId } = req.params;
            const { cacheKey } = req.query;

            if (!cacheKey) {
                return res.status(400).json({
                    error: 'Missing required query parameter: cacheKey'
                });
            }

            const cached = swipeCache.get(cacheKey);
            if (!isCacheValid(cached)) {
                return res.status(404).json({
                    error: 'Swipe data not found or expired'
                });
            }

            const swipeData = cached.data[nodeId];
            if (!swipeData) {
                return res.json({ swipes: [] });
            }

            res.json({
                swipes: swipeData.storedSwipes,
                totalSwipes: swipeData.totalSwipes,
                currentSwipeIndex: swipeData.currentSwipeIndex
            });
        } catch (error) {
            console.error('[timelines-data] Error in swipes endpoint:', error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * Invalidate cache
     * POST /api/plugins/timelines-data/invalidate-cache
     */
    router.post('/invalidate-cache', (req, res) => {
        try {
            const { avatar_url, is_group } = req.body;

            if (avatar_url) {
                const cacheKey = getCacheKey(avatar_url, is_group);
                responseCache.delete(cacheKey);
                swipeCache.delete(cacheKey);
            } else {
                responseCache.clear();
                swipeCache.clear();
            }

            res.json({ success: true });
        } catch (error) {
            console.error('[timelines-data] Error invalidating cache:', error);
            res.status(500).json({ error: error.message });
        }
    });

    console.log('[timelines-data] Plugin loaded! Endpoint: /api/plugins/timelines-data/bulk-fetch');
    return Promise.resolve();
}

/**
 * Cleanup function called on server shutdown
 * @returns {Promise<void>}
 */
async function exit() {
    responseCache.clear();
    swipeCache.clear();
    console.log('[timelines-data] Plugin unloaded.');
    return Promise.resolve();
}

/**
 * Plugin metadata and exports
 */
const info = {
    id: 'timelines-data',
    name: 'Timelines Data',
    description: 'Provides a bulk fetch endpoint with server-side graph building'
};

export { init, exit, info };
