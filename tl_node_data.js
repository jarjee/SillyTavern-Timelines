import { characters, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { convertToCytoscapeElements, generateUniqueColor } from './tl_core.js';

// Core data processing functions moved to tl_core.js shared module
// This reduces code duplication and improves maintainability

/**
 * Fetches all chats associated with a specific character based on their avatar URL.
 *
 * @async
 * @param {string} characterAvatar - The URL of the character's avatar, used as an identifier to fetch chats.
 * @returns {Promise<Object|undefined>} A promise that resolves with the JSON representation of the chat data
 *                                      or undefined if the fetch request is not successful.
 * @throws Will throw an error if there's an issue with the fetch request itself.
 */
export async function fetchData(characterAvatar) {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        body: JSON.stringify({ avatar_url: characterAvatar }),
        headers: getRequestHeaders(),
    });
    if (!response.ok) {
        return;
    }
    return response.json();
}

/**
 * Attempts to fetch all chat data via the bulk endpoint (optimized server plugin).
 * Falls back to individual requests if the plugin is not installed.
 *
 * @async
 * @param {string} characterAvatar - The URL of the character's avatar
 * @param {boolean} isGroupChat - Whether this is a group chat
 * @returns {Promise<Object|null>} Bulk chat data or null if endpoint not available
 */
async function fetchDataBulk(characterAvatar, isGroupChat) {
    try {
        const response = await fetch('/api/plugins/timelines-data/bulk-fetch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: characterAvatar,
                is_group: isGroupChat,
            }),
            headers: getRequestHeaders(),
        });

        // If 404, the plugin is not installed - return null for fallback
        if (response.status === 404) {
            return null;
        }

        if (!response.ok) {
            console.warn(`Bulk fetch failed with status ${response.status}, falling back to individual requests`);
            return null;
        }

        const bulkData = await response.json();
        console.log('Successfully fetched timeline data via bulk endpoint');
        return bulkData;

    } catch (error) {
        console.warn('Bulk fetch endpoint error, falling back to individual requests:', error.message);
        return null;
    }
}

/**
 * Prepares chat data by fetching detailed chat content, sorting by file names, and converting
 * the consolidated data into a format suitable for Cytoscape visualization. This function
 * fetches individual or group chat data based on the `isGroupChat` flag.
 *
 * First attempts to use the optimized bulk endpoint if available (server plugin),
 * then falls back to individual requests if the plugin is not installed.
 *
 * @async
 * @param {Object} data - A dictionary containing summary or metadata of chats.
 * @param {boolean} isGroupChat - A flag indicating whether the chat data is for group chats (true)
 *                                or individual chats (false).
 * @returns {Promise<Array>} A promise that resolves with a list of nodes (and potentially edges)
 *                           suitable for the Cytoscape graph library.
 * @throws Will throw an error if the fetch request or data processing encounters issues.
 */
export async function prepareData(data, isGroupChat) {
    const context = getContext();
    const characterAvatar = characters[context.characterId].avatar;

    // Try bulk fetch first (if server plugin is installed)
    const bulkData = await fetchDataBulk(characterAvatar, isGroupChat);

    if (bulkData && bulkData.graph) {
        // Server-side graph building - return prebuilt graph directly
        console.log('Using server-side prebuilt graph');
        return bulkData.graph;
    }

    // Fallback: Individual requests (original behavior)
    console.log('Using individual chat requests (server plugin not detected)');
    let chat_dict = {};
    let chat_list = Object.values(data).sort((a, b) => a['file_name'].localeCompare(b['file_name'])).reverse();

    for (const { file_name } of chat_list) {
        try {
            const endpoint = isGroupChat ? '/api/chats/group/get' : '/api/chats/get';
            const requestBody = isGroupChat
                ? JSON.stringify({ id: file_name })
                : JSON.stringify({
                    ch_name: characters[context.characterId].name,
                    file_name: file_name.replace('.jsonl', ''),
                    avatar_url: characters[context.characterId].avatar,
                });

            const chatResponse = await fetch(endpoint, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: requestBody,
                cache: 'no-cache',
            });

            if (!chatResponse.ok) {
                continue;
            }

            const currentChat = await chatResponse.json();
            if (!isGroupChat) {
                // remove the first message, which is metadata, only for individual chats
                currentChat.shift();
            }
            chat_dict[file_name] = currentChat;

        } catch (error) {
            console.error(error);
        }
    }

    // Use optimized shared module for client-side processing
    const { elements } = convertToCytoscapeElements(chat_dict);
    return elements;
}
