import { bench, describe } from 'vitest';
import {
    cyrb128,
    sfc32,
    generateUniqueColor,
    normalizeMessageText,
    preprocessChatSessions,
    groupMessagesByContent,
    buildGraph,
    convertToCytoscapeElements
} from '../tl_core.js';

// Helper to generate test data
function generateTestChatHistory(numChats, messagesPerChat) {
    const chatHistory = {};

    for (let i = 0; i < numChats; i++) {
        const chatName = `chat${i}.jsonl`;
        const messages = [];

        for (let j = 0; j < messagesPerChat; j++) {
            messages.push({
                mes: `Message ${j} from chat ${i}\r\nMultiline content here`,
                name: j % 2 === 0 ? 'AI' : 'User',
                is_user: j % 2 === 1,
                is_system: false,
                send_date: `2024-01-${(j % 28) + 1}`,
                swipes: j % 3 === 0 ? [`Alt 1 for msg ${j}`, `Alt 2 for msg ${j}`] : undefined
            });
        }

        chatHistory[chatName] = messages;
    }

    return chatHistory;
}

function generateTransposedChats(numChats, messagesPerChat) {
    const chatHistory = generateTestChatHistory(numChats, messagesPerChat);
    return preprocessChatSessions(chatHistory);
}

describe('Hash and RNG Performance', () => {
    const testStrings = [
        'short',
        'medium length string here',
        'very long string with lots of content that might be representative of a chat message with multiple sentences and detailed information'
    ];

    bench('cyrb128 - short string', () => {
        cyrb128(testStrings[0]);
    });

    bench('cyrb128 - medium string', () => {
        cyrb128(testStrings[1]);
    });

    bench('cyrb128 - long string', () => {
        cyrb128(testStrings[2]);
    });

    bench('sfc32 - 1000 numbers', () => {
        const rng = sfc32(1, 2, 3, 4);
        for (let i = 0; i < 1000; i++) {
            rng();
        }
    });

    bench('generateUniqueColor - with seed', () => {
        generateUniqueColor('checkpoint name');
    });

    bench('generateUniqueColor - without seed', () => {
        generateUniqueColor();
    });
});

describe('Text Normalization Performance', () => {
    const texts = {
        small: 'Hello\r\nWorld',
        medium: 'Line 1\r\nLine 2\r\nLine 3\r\nLine 4\r\nLine 5\r\nLine 6\r\nLine 7\r\nLine 8\r\nLine 9\r\nLine 10',
        large: Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\r\n')
    };

    bench('normalizeMessageText - small (cached)', () => {
        normalizeMessageText(texts.small);
    });

    bench('normalizeMessageText - medium (cached)', () => {
        normalizeMessageText(texts.medium);
    });

    bench('normalizeMessageText - large (cached)', () => {
        normalizeMessageText(texts.large);
    });

    bench('normalizeMessageText - unique texts (uncached)', () => {
        normalizeMessageText(`Unique text ${Math.random()}\r\nwith newlines`);
    });
});

describe('Preprocessing Performance', () => {
    const smallHistory = generateTestChatHistory(5, 20);
    const mediumHistory = generateTestChatHistory(10, 50);
    const largeHistory = generateTestChatHistory(20, 100);

    bench('preprocessChatSessions - small (5 chats × 20 msgs)', () => {
        preprocessChatSessions(smallHistory);
    });

    bench('preprocessChatSessions - medium (10 chats × 50 msgs)', () => {
        preprocessChatSessions(mediumHistory);
    });

    bench('preprocessChatSessions - large (20 chats × 100 msgs)', () => {
        preprocessChatSessions(largeHistory);
    });
});

describe('Message Grouping Performance', () => {
    // Create messages at same depth with varying content similarity
    const smallMessages = Array.from({ length: 10 }, (_, i) => ({
        file_name: `chat${i}.jsonl`,
        message: { mes: i % 3 === 0 ? 'shared message' : `unique ${i}` }
    }));

    const mediumMessages = Array.from({ length: 50 }, (_, i) => ({
        file_name: `chat${i}.jsonl`,
        message: { mes: i % 5 === 0 ? 'shared message\r\n' : `unique ${i}\r\n` }
    }));

    const largeMessages = Array.from({ length: 200 }, (_, i) => ({
        file_name: `chat${i}.jsonl`,
        message: { mes: i % 10 === 0 ? 'shared\r\nmessage' : `unique ${i}\r\nmessage` }
    }));

    bench('groupMessagesByContent - small (10 messages)', () => {
        groupMessagesByContent(smallMessages);
    });

    bench('groupMessagesByContent - medium (50 messages)', () => {
        groupMessagesByContent(mediumMessages);
    });

    bench('groupMessagesByContent - large (200 messages)', () => {
        groupMessagesByContent(largeMessages);
    });
});

describe('Graph Building Performance', () => {
    const smallChats = generateTransposedChats(3, 10);
    const mediumChats = generateTransposedChats(5, 50);
    const largeChats = generateTransposedChats(10, 100);

    const smallLengths = Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`chat${i}.jsonl`, 10])
    );
    const mediumLengths = Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`chat${i}.jsonl`, 50])
    );
    const largeLengths = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`chat${i}.jsonl`, 100])
    );

    bench('buildGraph - small (3 chats × 10 msgs)', () => {
        buildGraph(smallChats, smallLengths);
    });

    bench('buildGraph - medium (5 chats × 50 msgs)', () => {
        buildGraph(mediumChats, mediumLengths);
    });

    bench('buildGraph - large (10 chats × 100 msgs)', () => {
        buildGraph(largeChats, largeLengths);
    });
});

describe('End-to-End Performance', () => {
    const smallHistory = generateTestChatHistory(3, 10);
    const mediumHistory = generateTestChatHistory(5, 50);
    const largeHistory = generateTestChatHistory(10, 100);
    const veryLargeHistory = generateTestChatHistory(20, 200);

    bench('convertToCytoscapeElements - small (3 chats × 10 msgs)', () => {
        convertToCytoscapeElements(smallHistory);
    });

    bench('convertToCytoscapeElements - medium (5 chats × 50 msgs)', () => {
        convertToCytoscapeElements(mediumHistory);
    });

    bench('convertToCytoscapeElements - large (10 chats × 100 msgs)', () => {
        convertToCytoscapeElements(largeHistory);
    });

    bench('convertToCytoscapeElements - very large (20 chats × 200 msgs)', () => {
        convertToCytoscapeElements(veryLargeHistory);
    });
});

describe('Memory and Caching Impact', () => {
    const history = generateTestChatHistory(5, 50);

    bench('convertToCytoscapeElements - repeated calls (cache warmup)', () => {
        // This tests cache effectiveness
        convertToCytoscapeElements(history);
    });

    bench('convertToCytoscapeElements - with unique data (no cache)', () => {
        // Generate new data each time to avoid cache hits
        const uniqueHistory = generateTestChatHistory(5, 50);
        convertToCytoscapeElements(uniqueHistory);
    });
});
