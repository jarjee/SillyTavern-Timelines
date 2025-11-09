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
    // Try to find the user's data directory
    // First, check for multi-user setup: ./data/{user}/chats/
    const serverRoot = path.resolve(__dirname, '../../');
    const dataDir = path.join(serverRoot, 'data');

    // Look for user directories in ./data/
    // For now, use the first user directory found or 'default-user'
    let userDir = 'default-user';

    try {
        if (await fileExists(dataDir)) {
            const entries = await fs.readdir(dataDir, { withFileTypes: true });
            const userDirs = entries
                .filter(entry => entry.isDirectory())
                .filter(entry => !entry.name.startsWith('_'))  // Exclude system dirs starting with _
                .filter(entry => !entry.name.startsWith('.'));  // Exclude hidden dirs

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
        // Remove .png extension from avatar URL to get character folder name
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

/**
 * Initialize plugin with Express router
 * @param {import('express').Router} router - Express router instance
 * @returns {Promise<void>}
 */
async function init(router) {
    /**
     * Bulk fetch endpoint - Get all chats for a character in a single request
     * POST /api/plugins/timelines-data/bulk-fetch
     *
     * Request body:
     * {
     *   avatar_url: "character_name.png" (for individual chats),
     *   is_group?: false (optional, defaults to false)
     * }
     *
     * Response:
     * {
     *   chats: {
     *     "chat1.jsonl": [array of messages],
     *     "chat2.jsonl": [array of messages],
     *     ...
     *   },
     *   metadata: {
     *     "chat1.jsonl": { file_size, chat_items, mes, last_mes },
     *     ...
     *   }
     * }
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

            // Resolve the correct chat directory (handles multi-user setups)
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

                    // Remove metadata line (first line) for individual chats only
                    // Metadata lines have chat_metadata or lack the 'mes' field that all real messages have
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

            // Cache the response
            responseCache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            res.json(result);
        } catch (error) {
            console.error('[timelines-data] Error in bulk-fetch endpoint:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    // Invalidation endpoint for cache
    // This can be called when chats are updated
    router.post('/invalidate-cache', (req, res) => {
        try {
            const { avatar_url, is_group } = req.body;

            if (avatar_url) {
                const cacheKey = getCacheKey(avatar_url, is_group);
                responseCache.delete(cacheKey);
            } else {
                // Clear all cache
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
    description: 'Provides a bulk fetch endpoint for efficient timeline data retrieval'
};

export { init, exit, info };
