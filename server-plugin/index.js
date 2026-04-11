import path from 'path';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { createContext, runInContext } from 'vm';

const gzipAsync = promisify(gzip);
const GZIP_LEVEL = 3;
const FILE_READ_CONCURRENCY = Number.parseInt(process.env.TIMELINES_FILE_READ_CONCURRENCY || '8', 10) || 8;
const ENABLE_LAYOUT_DIAGNOSTICS = process.env.TIMELINES_LAYOUT_DEBUG === '1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dagre.js is a Browserify UMD bundle designed for browsers. Node's CJS require
// causes its internal graphlib module to fail (the fallback path references
// `window` which doesn't exist in Node). Load it via vm with a minimal browser-
// like context so the UMD's CJS branch sets module.exports correctly.
const dagrePath = path.resolve(__dirname, '../dagre.js');
const dagreSrc = readFileSync(dagrePath, 'utf8');
const dagreCtx = createContext({ module: { exports: {} }, exports: {}, global: {}, window: {}, self: {} });
runInContext(dagreSrc, dagreCtx);
const dagre = dagreCtx.module.exports;

/**
 * Response cache with TTL (Time To Live)
 * Stores cached responses for quick repeated requests
 */
const responseCache = new Map();
const CACHE_TTL = 30000; // 30 seconds in milliseconds

/**
 * Get or create cache key for a character/group/layout combination
 * @param {string} characterId - Avatar URL (for individual) or group ID
 * @param {boolean} isGroup - Whether this is a group chat
 * @param {Object} layoutSettings - Layout settings that affect the graph
 * @param {string} userHandle - User handle for multi-user isolation
 * @returns {string} Cache key
 */
function getCacheKey(characterId, isGroup, layoutSettings, userHandle = '') {
    const layoutHash = layoutSettings ? JSON.stringify(layoutSettings) : '';
    return `${userHandle}:${isGroup ? 'group' : 'char'}:${characterId}:${layoutHash}`;
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
 * Check if the request supports gzip-compressed responses.
 * @param {import('express').Request} req - Express request
 * @returns {boolean} True if gzip is accepted
 */
function clientAcceptsGzip(req) {
    const acceptEncoding = String(req.headers?.['accept-encoding'] || '');
    return /\bgzip\b/i.test(acceptEncoding);
}

/**
 * Parse JSONL chat content in a single pass.
 * Matches existing behavior by skipping empty lines and logging malformed lines.
 *
 * @param {string} content - Raw JSONL file content
 * @param {string} fileName - Source file name used in parse error logs
 * @returns {Array<Object>} Parsed message objects
 */
function parseJsonlMessages(content, fileName) {
    const messages = [];
    const trimmed = content.trim();

    if (trimmed.length === 0) {
        return messages;
    }

    let lineIndex = 0;
    let lineStart = 0;
    for (let i = 0; i <= trimmed.length; i++) {
        const isLineBreak = i === trimmed.length || trimmed.charCodeAt(i) === 10; // '\n'
        if (!isLineBreak) {
            continue;
        }

        let line = trimmed.slice(lineStart, i);
        lineStart = i + 1;

        if (line.endsWith('\r')) {
            line = line.slice(0, -1);
        }
        if (line.length === 0) {
            continue;
        }

        try {
            messages.push(JSON.parse(line));
        } catch (e) {
            console.error(`Failed to parse line ${lineIndex} in ${fileName}:`, e.message);
        }
        lineIndex++;
    }

    return messages;
}

/**
 * Run async work with bounded concurrency.
 *
 * @template T,U
 * @param {Array<T>} items - Items to process
 * @param {number} concurrency - Max concurrent workers
 * @param {(item: T, index: number) => Promise<U>} worker - Async worker function
 * @returns {Promise<Array<U>>} Results in input order
 */
async function mapWithConcurrency(items, concurrency, worker) {
    const normalizedConcurrency = Math.max(1, concurrency);
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex++;
            if (currentIndex >= items.length) {
                return;
            }
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    }

    const workers = [];
    const workerCount = Math.min(normalizedConcurrency, items.length);
    for (let i = 0; i < workerCount; i++) {
        workers.push(runWorker());
    }

    await Promise.all(workers);
    return results;
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
 * Resolve chat directory from request user directories.
 * Mirrors the pattern in SillyTavern's own endpoints/chats.js.
 * @param {Object} userDirectories - req.user.directories
 * @param {string} avatar_url - The character avatar filename
 * @param {boolean} is_group - Whether this is a group chat
 * @returns {string} Path to the chat directory
 */
function resolveChatDirectory(userDirectories, avatar_url, is_group) {
    if (is_group) {
        return userDirectories.groupChats;
    }
    return path.join(userDirectories.chats, String(avatar_url).replace('.png', ''));
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
 * @returns {Array} Cytoscape elements
 */
function buildGraph(allChats, allChatFileNamesAndLengths) {
    let cyElements = [];
    let keyCounter = 1;
    let previousNodes = {};
    let parentSwipeData = {};

    // Accumulators for per-phase timing within the main loop
    let timeGrouping = 0;
    let timeCreateNode = 0;
    let timeSwipes = 0;
    let timeEdges = 0;

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

    // Initialize previousNodes (guard for empty allChats)
    if (allChats.length > 0) {
        allChats[0].forEach(({ file_name }) => {
            previousNodes[file_name] = 'root';
        });
    }

    // Process each message depth
    for (let messageId = 0; messageId < allChats.length; messageId++) {
        let tPhase = performance.now();
        let groups = groupMessagesByContent(allChats[messageId]);
        timeGrouping += performance.now() - tPhase;

        for (const [text, group] of Object.entries(groups)) {
            let tNode = performance.now();
            const nodeId = `message${keyCounter}`;
            const node = createNode(nodeId, messageId, text, group, allChatFileNamesAndLengths);
            timeCreateNode += performance.now() - tNode;

            // Extract swipes (skip greeting messages at index 0)
            let tSwipe = performance.now();
            const allSwipes = [];
            let uniqueSwipes = [];
            if (messageId !== 0) {
                group.forEach(messageObj => {
                    const swipes = messageObj.message.swipes || [];
                    allSwipes.push(...swipes);
                });
                uniqueSwipes = [...new Set(allSwipes)].filter(swipeText => swipeText !== text);
            }

            // Push node once per unique text group
            cyElements.push({
                group: 'nodes',
                data: node,
            });

            // Process each message in the group
            const uniqueParents = new Set();
            const seenEdgePairs = new Set();
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

                // Only push an edge if this (source, target) pair is new
                const edgeKey = `${parentNodeId}>${nodeId}`;
                if (!seenEdgePairs.has(edgeKey)) {
                    seenEdgePairs.add(edgeKey);
                    cyElements.push({
                        group: 'edges',
                        data: {
                            id: `edge${keyCounter}`,
                            source: parentNodeId,
                            target: nodeId,
                        },
                    });
                    keyCounter += 1;
                }

                previousNodes[messageObj.file_name] = nodeId;
            }
            timeSwipes += performance.now() - tSwipe;
        }
    }

    // Attach swipe data to parent nodes
    const tAttach = performance.now();
    cyElements.forEach(element => {
        if (element.group === 'nodes' && parentSwipeData[element.data.id]) {
            Object.assign(element.data, parentSwipeData[element.data.id]);
        }
    });

    console.log(`[timelines-data] [perf]     buildGraph breakdown: grouping=${timeGrouping.toFixed(1)}ms, createNode=${timeCreateNode.toFixed(1)}ms, swipes+edges=${timeSwipes.toFixed(1)}ms, attachSwipeData=${(performance.now() - tAttach).toFixed(1)}ms`);
    return cyElements;
}

/**
 * Convert chat history to Cytoscape elements
 * @param {Object} chatHistory - {file_name: [messages]}
 * @returns {Array} Cytoscape elements
 */
function convertToCytoscapeElements(chatHistory) {
    const tPreprocess = performance.now();
    let allChats = preprocessChatSessions(chatHistory);
    console.log(`[timelines-data] [perf]   preprocessChatSessions (${allChats.length} depth levels) took ${(performance.now() - tPreprocess).toFixed(1)}ms`);

    // Get chat lengths
    let allChatFileNamesAndLengths = {};
    for (const [key, val] of Object.entries(chatHistory)) {
        allChatFileNamesAndLengths[key] = val.length;
    }

    const tBuild = performance.now();
    let elements = buildGraph(allChats, allChatFileNamesAndLengths);
    console.log(`[timelines-data] [perf]   buildGraph (${elements.length} elements) took ${(performance.now() - tBuild).toFixed(1)}ms`);

    const tHighlight = performance.now();
    elements = highlightCheckpointPaths(elements);
    console.log(`[timelines-data] [perf]   highlightCheckpointPaths took ${(performance.now() - tHighlight).toFixed(1)}ms`);

    return elements;
}

// ============================================================================
// POST-PROCESSING: HIGHLIGHTING & LAYOUT
// ============================================================================

/**
 * Highlight checkpoint paths from each bookmark node to the root.
 * Identical to the frontend's highlightPathToRoot in tl_style.js,
 * applied to each bookmark node.
 * @param {Array} rawData - Cytoscape elements
 * @returns {Array} Modified elements (mutated in place)
 */
function highlightCheckpointPaths(rawData) {
    const bookmarkNodes = rawData.filter(entry =>
        entry.group === 'nodes' && entry.data.isBookmark
    );

    // Build indexes for O(1) lookup instead of O(N) linear scans
    const nodeById = new Map();
    const edgeByTarget = new Map();
    for (const entry of rawData) {
        if (entry.group === 'nodes') {
            nodeById.set(entry.data.id, entry);
        } else if (entry.group === 'edges') {
            edgeByTarget.set(entry.data.target, entry);
        }
    }

    bookmarkNodes.forEach(bookmarkNode => {
        let currentNode = bookmarkNode;
        let currentZIndex = 1000;
        let currentHighlightThickness = 4;

        while (currentNode) {
            if (currentNode !== bookmarkNode && currentNode.data.isBookmark) {
                break;
            }

            let incomingEdge = edgeByTarget.get(currentNode.data.id);

            if (incomingEdge) {
                incomingEdge.data.isHighlight = true;
                incomingEdge.data.color = bookmarkNode.data.color;
                incomingEdge.data.bookmarkName = bookmarkNode.data.bookmarkName;
                incomingEdge.data.highlightThickness = currentHighlightThickness;
                currentHighlightThickness = Math.min(currentHighlightThickness + 0.1, 6);

                currentNode.data.borderColor = incomingEdge.data.color;

                incomingEdge.data.zIndex = currentZIndex;
                currentZIndex++;

                currentNode = nodeById.get(incomingEdge.data.source);
            } else {
                currentNode = null;
            }
        }
    });

    return rawData;
}

/**
 * Compute dagre layout positions server-side and bake them into elements.
 * Replicates the exact behavior of cytoscape-dagre so positions match.
 *
 * @param {Array} elements - Cytoscape elements (nodes and edges)
 * @param {Object} layoutSettings - Layout configuration from the frontend
 * @returns {Array} Elements with position data baked in
 */
function computeLayout(elements, layoutSettings) {
    const tSetup = performance.now();
    const g = new dagre.graphlib.Graph({});

    const gObj = {};
    if (layoutSettings.nodeSep != null) gObj.nodesep = layoutSettings.nodeSep;
    if (layoutSettings.edgeSep != null) gObj.edgesep = layoutSettings.edgeSep;
    if (layoutSettings.rankSep != null) gObj.ranksep = layoutSettings.rankSep;
    if (layoutSettings.rankDir != null) gObj.rankdir = layoutSettings.rankDir;
    if (layoutSettings.align != null) gObj.align = layoutSettings.align;
    if (layoutSettings.ranker != null) gObj.ranker = layoutSettings.ranker;
    if (layoutSettings.acyclicer != null) gObj.acyclicer = layoutSettings.acyclicer;
    g.setGraph(gObj);
    g.setDefaultEdgeLabel(function () { return {}; });
    g.setDefaultNodeLabel(function () { return {}; });

    const defaultNodeWidth = layoutSettings.nodeWidth || 25;
    const defaultNodeHeight = layoutSettings.nodeHeight || 25;
    const avatarAsRoot = layoutSettings.avatarAsRoot !== false;
    const swipeScale = layoutSettings.swipeScale || false;
    const spacingFactor = layoutSettings.spacingFactor || 1;

    // Collect nodes, sorted by id (replicating cytoscape-dagre's sort behavior)
    const nodes = elements
        .filter(e => e.group === 'nodes')
        .sort((a, b) => a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0);

    const edges = elements.filter(e => e.group === 'edges');
    const uniqueEdgePairs = new Set();
    let duplicateEdgeCount = 0;

    if (ENABLE_LAYOUT_DIAGNOSTICS) {
        // Count unique node IDs to detect duplicate pushes
        const uniqueNodeIds = new Set(nodes.map(n => n.data.id));
        console.log(`[timelines-data] [perf]   computeLayout: ${nodes.length} node elements (${uniqueNodeIds.size} unique IDs), ${edges.length} edges`);
    }

    // Add nodes to dagre graph with dimensions matching what Cytoscape would compute
    for (const node of nodes) {
        let w, h;
        if (node.data.label === 'root') {
            // Root node dimensions match tl_style.js root node selector
            w = avatarAsRoot ? 40 : defaultNodeWidth;
            h = avatarAsRoot ? 50 : defaultNodeHeight;
        } else {
            // Replicate swipeScale logic from tl_style.js node selector
            let totalSwipes = Number(node.data.totalSwipes);
            if (isNaN(totalSwipes)) totalSwipes = 0;
            w = swipeScale ? Math.abs(Math.log(totalSwipes + 1)) * 4 + defaultNodeWidth : defaultNodeWidth;
            h = swipeScale ? Math.abs(Math.log(totalSwipes + 1)) * 4 + defaultNodeHeight : defaultNodeHeight;
        }
        g.setNode(node.data.id, { width: w, height: h, name: node.data.id });
    }

    // Add edges to dagre graph
    for (const edge of edges) {
        const edgeKey = `${edge.data.source}\u0000${edge.data.target}`;
        if (uniqueEdgePairs.has(edgeKey)) {
            duplicateEdgeCount++;
            continue;
        }
        uniqueEdgePairs.add(edgeKey);

        g.setEdge(edge.data.source, edge.data.target, {
            minlen: 1,
            weight: 1,
        });
    }

    if (ENABLE_LAYOUT_DIAGNOSTICS && duplicateEdgeCount > 0) {
        console.log(`[timelines-data] [perf]   computeLayout: skipped ${duplicateEdgeCount} duplicate edges before dagre insertion`);
    }
    if (ENABLE_LAYOUT_DIAGNOSTICS) {
        console.log(`[timelines-data] [perf]   computeLayout: ${uniqueEdgePairs.size} unique edge pairs (${duplicateEdgeCount} duplicate edges)`);
    }

    console.log(`[timelines-data] [perf]   computeLayout: graph setup took ${(performance.now() - tSetup).toFixed(1)}ms, dagre graph has ${g.nodeCount()} nodes, ${g.edgeCount()} edges`);
    console.log(`[timelines-data] [perf]   computeLayout: ranker=${gObj.ranker || 'default'}, rankdir=${gObj.rankdir || 'default'}`);

    // Run dagre layout
    const tDagre = performance.now();
    dagre.layout(g);
    console.log(`[timelines-data] [perf]   computeLayout: dagre.layout() took ${(performance.now() - tDagre).toFixed(1)}ms`);

    // Bake positions into element data, applying spacingFactor
    const tBake = performance.now();
    for (const node of nodes) {
        const pos = g.node(node.data.id);
        if (pos) {
            node.position = {
                x: pos.x * spacingFactor,
                y: pos.y * spacingFactor,
            };
        }
    }
    console.log(`[timelines-data] [perf]   computeLayout: position baking took ${(performance.now() - tBake).toFixed(1)}ms`);

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
            const t0 = performance.now();
            const { avatar_url, is_group = false, layout_settings } = req.body;
            const shouldGzip = clientAcceptsGzip(req);

            if (!avatar_url) {
                return res.status(400).json({
                    error: 'Missing required field: avatar_url'
                });
            }

            const userHandle = req.user?.profile?.handle ?? '';
            const cacheKey = getCacheKey(avatar_url, is_group, layout_settings, userHandle);

            // Check cache first
            const cached = responseCache.get(cacheKey);
            if (isCacheValid(cached)) {
                console.log(`[timelines-data] [perf] Cache hit, serving cached response`);
                const tCacheStart = performance.now();
                res.setHeader('Content-Type', 'application/json');
                if (shouldGzip && cached.gzip) {
                    res.setHeader('Content-Encoding', 'gzip');
                    res.end(cached.gzip);
                } else if (cached.json) {
                    res.end(cached.json);
                } else {
                    // Backward compatibility for pre-change cache entries.
                    res.setHeader('Content-Encoding', 'gzip');
                    res.end(cached.data);
                }
                console.log(`[timelines-data] [perf] Cache hit response took ${(performance.now() - tCacheStart).toFixed(1)}ms`);
                return;
            }

            // Resolve chat directory from the authenticated user's directories
            const chatDirectory = resolveChatDirectory(req.user.directories, avatar_url, is_group);

            const result = {
                chats: {},
                metadata: {}
            };

            // Check if directory exists
            if (!(await fileExists(chatDirectory))) {
                console.warn('[timelines-data] Chat directory does not exist:', chatDirectory);
                return res.json({ graph: [], metadata: {}, serverComputed: false });
            }

            // Read directory of chats
            const tDirRead = performance.now();
            const files = await fs.readdir(chatDirectory, { withFileTypes: true });
            const chatFiles = files
                .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
                .sort((a, b) => b.name.localeCompare(a.name));
            console.log(`[timelines-data] [perf] Directory listing (${chatFiles.length} files) took ${(performance.now() - tDirRead).toFixed(1)}ms`);

            // Fetch chats with bounded concurrency
            const tFileRead = performance.now();
            let totalMessages = 0;
            let totalBytes = 0;
            const chatReadResults = await mapWithConcurrency(chatFiles, FILE_READ_CONCURRENCY, async (file) => {
                try {
                    const chatPath = path.join(chatDirectory, file.name);
                    const content = await fs.readFile(chatPath, 'utf8');
                    const bytes = Buffer.byteLength(content, 'utf8');
                    const messages = parseJsonlMessages(content, file.name);

                    // Remove metadata line for individual chats.
                    // The first line of a .jsonl chat file is always metadata for non-group chats,
                    // matching the frontend behavior where currentChat.shift() is unconditional.
                    if (!is_group && messages.length > 0) {
                        messages.shift();
                    }

                    // Get file stats for metadata
                    const stat = await fs.stat(chatPath);
                    const lastMessage = messages[messages.length - 1];

                    return {
                        fileName: file.name,
                        bytes,
                        messages,
                        metadata: {
                        file_size: formatFileSize(stat.size),
                        chat_items: messages.length,
                        mes: lastMessage ? lastMessage.mes : '',
                        last_mes: lastMessage ? lastMessage.send_date : stat.mtimeMs
                        },
                    };
                } catch (e) {
                    console.error(`Error reading chat ${file.name}:`, e.message);
                    return null;
                }
            });

            for (const chatData of chatReadResults) {
                if (!chatData) {
                    continue;
                }
                result.chats[chatData.fileName] = chatData.messages;
                result.metadata[chatData.fileName] = chatData.metadata;
                totalMessages += chatData.messages.length;
                totalBytes += chatData.bytes;
            }
            console.log(`[timelines-data] [perf] File read + parse (${chatFiles.length} files, ${totalMessages} messages, ${(totalBytes / 1024 / 1024).toFixed(1)}MB) took ${(performance.now() - tFileRead).toFixed(1)}ms`);

            // Build graph server-side
            const tGraph = performance.now();
            let graphElements = convertToCytoscapeElements(result.chats);
            console.log(`[timelines-data] [perf] convertToCytoscapeElements (${graphElements.length} elements) took ${(performance.now() - tGraph).toFixed(1)}ms`);

            // Compute layout positions if layout settings were provided
            let serverComputed = false;
            if (layout_settings) {
                const tLayout = performance.now();
                graphElements = computeLayout(graphElements, layout_settings);
                serverComputed = true;
                console.log(`[timelines-data] [perf] computeLayout took ${(performance.now() - tLayout).toFixed(1)}ms`);
            }

            const response = {
                graph: graphElements,
                metadata: result.metadata,
                serverComputed: serverComputed,
            };

            // Serialize once and optionally compress for clients that accept gzip
            const tJson = performance.now();
            const jsonString = JSON.stringify(response);
            const jsonBuffer = Buffer.from(jsonString);
            const compressed = await gzipAsync(jsonBuffer, { level: GZIP_LEVEL });
            console.log(`[timelines-data] [perf] JSON serialize + gzip(lv${GZIP_LEVEL}) (${(jsonBuffer.length / 1024 / 1024).toFixed(1)}MB -> ${(compressed.length / 1024 / 1024).toFixed(1)}MB) took ${(performance.now() - tJson).toFixed(1)}ms`);

            responseCache.set(cacheKey, {
                json: jsonBuffer,
                gzip: compressed,
                timestamp: Date.now()
            });

            const tSend = performance.now();
            res.setHeader('Content-Type', 'application/json');
            if (shouldGzip) {
                res.setHeader('Content-Encoding', 'gzip');
                res.end(compressed);
            } else {
                res.end(jsonBuffer);
            }
            console.log(`[timelines-data] [perf] Send took ${(performance.now() - tSend).toFixed(1)}ms`);
            console.log(`[timelines-data] [perf] Total request time: ${(performance.now() - t0).toFixed(1)}ms`);
        } catch (error) {
            console.error('[timelines-data] Error in bulk-fetch endpoint:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    /**
     * Invalidate cache
     * POST /api/plugins/timelines-data/invalidate-cache
     */
    router.post('/invalidate-cache', (req, res) => {
        try {
            const { avatar_url, is_group } = req.body;
            const userHandle = req.user?.profile?.handle ?? '';

            if (avatar_url) {
                // Clear all cache entries for this character/group
                // (may have multiple entries for different layout settings)
                const prefix = `${userHandle}:${is_group ? 'group' : 'char'}:${avatar_url}:`;
                for (const key of responseCache.keys()) {
                    if (key.startsWith(prefix)) {
                        responseCache.delete(key);
                    }
                }
            } else {
                responseCache.clear();
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

export const _testExports = {
    sfc32, cyrb128, generateUniqueColor,
    parseJsonlMessages, mapWithConcurrency,
    preprocessChatSessions, groupMessagesByContent, createNode,
    buildGraph, convertToCytoscapeElements, highlightCheckpointPaths,
    computeLayout, formatFileSize, getCacheKey, isCacheValid,
    resolveChatDirectory,
    responseCache, CACHE_TTL,
};
