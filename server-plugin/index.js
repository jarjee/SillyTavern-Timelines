import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { convertToCytoscapeElements } from './tl_core.js';
import dagre from '@dagrejs/dagre';

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
// SWIPE CACHE MANAGEMENT
// ============================================================================
// Note: Graph building functions have been moved to tl_core.js shared module

// ============================================================================
// LAYOUT COMPUTATION
// ============================================================================

/**
 * Compute dagre layout positions for graph elements
 * @param {Array} elements - Cytoscape graph elements
 * @param {Object} layoutOptions - Layout configuration options
 * @returns {Object} Elements with computed positions
 */
function computeDagreLayout(elements, layoutOptions = {}) {
    const startTime = performance.now();

    // Create dagre graph
    const g = new dagre.graphlib.Graph({
        multigraph: true,
        compound: true
    });

    // Apply optimized settings based on graph size
    const nodes = elements.filter(e => e.group === 'nodes');
    const edges = elements.filter(e => e.group === 'edges');
    const nodeCount = nodes.length;

    // Size-based optimizations (matching client-side logic)
    let settings = {
        rankdir: layoutOptions.rankDir || 'LR',
        ranker: 'network-simplex',
        acyclicer: 'greedy',
        align: undefined,
        nodesep: 50,
        edgesep: 10,
        ranksep: 50
    };

    if (nodeCount >= 50) {
        settings.nodesep = 40;
    }
    if (nodeCount >= 100) {
        settings.nodesep = 30;
        settings.edgesep = 5;
        settings.ranksep = 40;
    }
    if (nodeCount >= 200) {
        settings.nodesep = 25;
        settings.edgesep = 3;
        settings.ranksep = 35;
    }
    if (nodeCount >= 500) {
        settings.nodesep = 20;
        settings.edgesep = 2;
        settings.ranksep = 30;
    }

    // Set graph options
    g.setGraph(settings);
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes to dagre graph
    nodes.forEach(node => {
        const width = layoutOptions.nodeWidth || 25;
        const height = layoutOptions.nodeHeight || 25;
        g.setNode(node.data.id, {
            width: width,
            height: height,
            label: node.data.id
        });
    });

    // Add edges to dagre graph
    edges.forEach(edge => {
        g.setEdge(edge.data.source, edge.data.target, {
            minlen: 1,
            weight: edge.data.weight || 1
        });
    });

    // Run dagre layout
    const layoutStart = performance.now();
    dagre.layout(g);
    const layoutDuration = performance.now() - layoutStart;

    // Apply computed positions to elements
    const positionedElements = elements.map(ele => {
        if (ele.group === 'nodes') {
            const node = g.node(ele.data.id);
            return {
                ...ele,
                position: {
                    x: node.x,
                    y: node.y
                }
            };
        }
        return ele;
    });

    const totalDuration = performance.now() - startTime;
    console.log(`[timelines-data] Server-side layout computed in ${layoutDuration.toFixed(2)}ms (total: ${totalDuration.toFixed(2)}ms) for ${nodeCount} nodes`);

    return positionedElements;
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
            const { avatar_url, is_group = false, computeLayout = true, layoutOptions = {} } = req.body;

            if (!avatar_url) {
                return res.status(400).json({
                    error: 'Missing required field: avatar_url'
                });
            }

            const cacheKey = getCacheKey(avatar_url, is_group);
            const fullCacheKey = `${cacheKey}:layout=${computeLayout}`;

            // Check cache first
            const cached = responseCache.get(fullCacheKey);
            if (isCacheValid(cached)) {
                console.log('[timelines-data] Returning cached response');
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

            // Build graph server-side using shared module
            let { elements: graphElements, swipeData } = convertToCytoscapeElements(result.chats);

            // Store swipes in cache for lazy loading
            swipeCache.set(cacheKey, {
                data: swipeData,
                timestamp: Date.now()
            });

            // Compute server-side layout if requested
            if (computeLayout) {
                graphElements = computeDagreLayout(graphElements, layoutOptions);
            }

            // Strip swipes from response to reduce size - they'll be lazy-loaded via /swipes/:nodeId
            graphElements.forEach(element => {
                if (element.group === 'nodes' && element.data.storedSwipes) {
                    delete element.data.storedSwipes;
                    // Keep totalSwipes and currentSwipeIndex for UI
                }
            });

            const response = {
                graph: graphElements,
                metadata: result.metadata,
                layoutComputed: computeLayout
            };

            // Cache the response
            responseCache.set(fullCacheKey, {
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
