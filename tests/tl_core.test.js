import { describe, it, expect, beforeEach } from 'vitest';
import {
    cyrb128,
    sfc32,
    generateUniqueColor,
    normalizeMessageText,
    preprocessChatSessions,
    groupMessagesByContent,
    createNode,
    buildGraph,
    highlightCheckpointPaths,
    convertToCytoscapeElements
} from '../tl_core.js';

describe('cyrb128', () => {
    it('should generate deterministic hash for same input', () => {
        const hash1 = cyrb128('test string');
        const hash2 = cyrb128('test string');
        expect(hash1).toEqual(hash2);
    });

    it('should generate different hashes for different inputs', () => {
        const hash1 = cyrb128('test1');
        const hash2 = cyrb128('test2');
        expect(hash1).not.toEqual(hash2);
    });

    it('should return array of 4 numbers', () => {
        const hash = cyrb128('test');
        expect(hash).toHaveLength(4);
        expect(hash.every(n => typeof n === 'number')).toBe(true);
    });

    it('should handle empty string', () => {
        const hash = cyrb128('');
        expect(hash).toHaveLength(4);
        expect(hash.every(n => typeof n === 'number')).toBe(true);
    });

    it('should handle special characters', () => {
        const hash = cyrb128('!@#$%^&*()_+{}[]|\\:";\'<>?,./');
        expect(hash).toHaveLength(4);
    });
});

describe('sfc32', () => {
    it('should generate random numbers between 0 and 1', () => {
        const rng = sfc32(1, 2, 3, 4);
        for (let i = 0; i < 100; i++) {
            const num = rng();
            expect(num).toBeGreaterThanOrEqual(0);
            expect(num).toBeLessThan(1);
        }
    });

    it('should be deterministic with same seed', () => {
        const rng1 = sfc32(1, 2, 3, 4);
        const rng2 = sfc32(1, 2, 3, 4);

        const nums1 = Array.from({ length: 10 }, () => rng1());
        const nums2 = Array.from({ length: 10 }, () => rng2());

        expect(nums1).toEqual(nums2);
    });

    it('should generate different sequences with different seeds', () => {
        const rng1 = sfc32(1, 2, 3, 4);
        const rng2 = sfc32(5, 6, 7, 8);

        const nums1 = Array.from({ length: 10 }, () => rng1());
        const nums2 = Array.from({ length: 10 }, () => rng2());

        expect(nums1).not.toEqual(nums2);
    });
});

describe('generateUniqueColor', () => {
    it('should generate RGB color string', () => {
        const color = generateUniqueColor('test');
        expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    });

    it('should generate same color for same input', () => {
        const color1 = generateUniqueColor('test');
        const color2 = generateUniqueColor('test');
        expect(color1).toBe(color2);
    });

    it('should generate different colors for different inputs', () => {
        const color1 = generateUniqueColor('test1');
        const color2 = generateUniqueColor('test2');
        expect(color1).not.toBe(color2);
    });

    it('should generate random color without seed', () => {
        const color = generateUniqueColor();
        expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    });

    it('should have RGB values between 0 and 255', () => {
        const color = generateUniqueColor('test');
        const match = color.match(/rgb\((\d+), (\d+), (\d+)\)/);
        const [, r, g, b] = match.map(Number);

        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(256);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThan(256);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(256);
    });
});

describe('normalizeMessageText', () => {
    it('should convert CRLF to LF', () => {
        const result = normalizeMessageText('line1\r\nline2\r\nline3');
        expect(result).toBe('line1\nline2\nline3');
    });

    it('should handle text without CRLF', () => {
        const result = normalizeMessageText('line1\nline2');
        expect(result).toBe('line1\nline2');
    });

    it('should cache results for repeated inputs', () => {
        const text = 'test\r\ntext';
        const result1 = normalizeMessageText(text);
        const result2 = normalizeMessageText(text);

        // Both should be the same reference (cached)
        expect(result1).toBe(result2);
    });

    it('should handle empty string', () => {
        const result = normalizeMessageText('');
        expect(result).toBe('');
    });

    it('should handle mixed line endings', () => {
        const result = normalizeMessageText('line1\r\nline2\nline3\r\nline4');
        expect(result).toBe('line1\nline2\nline3\nline4');
    });
});

describe('preprocessChatSessions', () => {
    it('should transpose chat history from file-based to depth-based', () => {
        const chatHistory = {
            'chat1.jsonl': [
                { mes: 'msg1', name: 'AI' },
                { mes: 'msg2', name: 'User' }
            ],
            'chat2.jsonl': [
                { mes: 'msg1', name: 'AI' },
                { mes: 'msg3', name: 'User' }
            ]
        };

        const result = preprocessChatSessions(chatHistory);

        expect(result).toHaveLength(2);
        expect(result[0]).toHaveLength(2); // Two chats have message at index 0
        expect(result[1]).toHaveLength(2); // Two chats have message at index 1

        expect(result[0][0].file_name).toBe('chat1.jsonl');
        expect(result[0][0].message.mes).toBe('msg1');
        expect(result[0][1].file_name).toBe('chat2.jsonl');
    });

    it('should handle empty chat history', () => {
        const result = preprocessChatSessions({});
        expect(result).toEqual([]);
    });

    it('should handle chats of different lengths', () => {
        const chatHistory = {
            'chat1.jsonl': [
                { mes: 'msg1' },
                { mes: 'msg2' },
                { mes: 'msg3' }
            ],
            'chat2.jsonl': [
                { mes: 'msg1' }
            ]
        };

        const result = preprocessChatSessions(chatHistory);

        expect(result).toHaveLength(3);
        expect(result[0]).toHaveLength(2); // Both chats have index 0
        expect(result[1]).toHaveLength(1); // Only chat1 has index 1
        expect(result[2]).toHaveLength(1); // Only chat1 has index 2
    });

    it('should preserve message index information', () => {
        const chatHistory = {
            'chat1.jsonl': [
                { mes: 'msg1' },
                { mes: 'msg2' }
            ]
        };

        const result = preprocessChatSessions(chatHistory);

        expect(result[0][0].index).toBe(0);
        expect(result[1][0].index).toBe(1);
    });
});

describe('groupMessagesByContent', () => {
    it('should group messages by identical content', () => {
        const messages = [
            { file_name: 'chat1.jsonl', message: { mes: 'hello' } },
            { file_name: 'chat2.jsonl', message: { mes: 'hello' } },
            { file_name: 'chat3.jsonl', message: { mes: 'goodbye' } }
        ];

        const result = groupMessagesByContent(messages);

        expect(Object.keys(result)).toHaveLength(2);
        expect(result['hello']).toHaveLength(2);
        expect(result['goodbye']).toHaveLength(1);
    });

    it('should normalize newlines when grouping', () => {
        const messages = [
            { file_name: 'chat1.jsonl', message: { mes: 'line1\r\nline2' } },
            { file_name: 'chat2.jsonl', message: { mes: 'line1\nline2' } }
        ];

        const result = groupMessagesByContent(messages);

        expect(Object.keys(result)).toHaveLength(1);
        expect(result['line1\nline2']).toHaveLength(2);
    });

    it('should handle empty messages array', () => {
        const result = groupMessagesByContent([]);
        expect(result).toEqual({});
    });

    it('should preserve message metadata in groups', () => {
        const messages = [
            { file_name: 'chat1.jsonl', message: { mes: 'hello', name: 'AI', is_user: false } }
        ];

        const result = groupMessagesByContent(messages);

        expect(result['hello'][0].file_name).toBe('chat1.jsonl');
        expect(result['hello'][0].message.name).toBe('AI');
        expect(result['hello'][0].message.is_user).toBe(false);
    });

    it('should handle malformed messages gracefully', () => {
        const messages = [
            { file_name: 'chat1.jsonl', message: { mes: 'valid' } },
            { file_name: 'chat2.jsonl', message: null },
        ];

        // Should not throw, just log error and continue
        expect(() => groupMessagesByContent(messages)).not.toThrow();
    });
});

describe('createNode', () => {
    const allChatLengths = {
        'chat1.jsonl': 10,
        'chat2.jsonl': 15
    };

    it('should create a basic node', () => {
        const group = [
            {
                file_name: 'chat1.jsonl',
                index: 0,
                message: {
                    mes: 'Hello',
                    name: 'AI',
                    is_user: false,
                    is_system: false,
                    send_date: '2024-01-01'
                }
            }
        ];

        const node = createNode('node1', 5, 'Hello', group, allChatLengths);

        expect(node.id).toBe('node1');
        expect(node.msg).toBe('Hello');
        expect(node.chat_depth).toBe(5);
        expect(node.name).toBe('AI');
        expect(node.is_user).toBe(false);
        expect(node.isBookmark).toBe(false);
        expect(node.chat_sessions).toHaveProperty('chat1.jsonl');
    });

    it('should detect checkpoint (bookmark) nodes with extra.bookmark_link', () => {
        const group = [
            {
                file_name: 'chat1.jsonl',
                index: 0,
                message: {
                    mes: 'Checkpoint',
                    name: 'System',
                    is_system: true,
                    extra: { bookmark_link: 'checkpoint_chat' }
                }
            }
        ];

        const allLengths = {
            'chat1.jsonl': 10,
            'checkpoint_chat.jsonl': 5
        };

        const node = createNode('node1', 3, 'Checkpoint', group, allLengths);

        expect(node.isBookmark).toBe(true);
        expect(node.bookmarkName).toBe('checkpoint_chat');
        expect(node.color).toBeTruthy(); // Should have a color
    });

    it('should detect legacy checkpoint format', () => {
        const group = [
            {
                file_name: 'chat1.jsonl',
                index: 0,
                message: {
                    mes: 'Bookmark created! Click here to open the bookmark chat file_name="old_checkpoint"',
                    is_system: true
                }
            }
        ];

        const allLengths = {
            'chat1.jsonl': 10,
            'old_checkpoint.jsonl': 5
        };

        const node = createNode('node1', 3, 'text', group, allLengths);

        expect(node.isBookmark).toBe(true);
        expect(node.bookmarkName).toBe('old_checkpoint');
    });

    it('should omit dead checkpoint links', () => {
        const group = [
            {
                file_name: 'chat1.jsonl',
                index: 0,
                message: {
                    mes: 'Checkpoint',
                    extra: { bookmark_link: 'nonexistent_chat' }
                }
            }
        ];

        const node = createNode('node1', 3, 'Checkpoint', group, allChatLengths);

        expect(node.isBookmark).toBe(false);
        expect(node.bookmarkName).toBeUndefined();
        expect(node.color).toBeNull();
    });

    it('should map chat sessions correctly', () => {
        const group = [
            {
                file_name: 'chat1.jsonl',
                index: 2,
                message: { mes: 'msg', name: 'AI', is_user: false }
            },
            {
                file_name: 'chat2.jsonl',
                index: 2,
                message: { mes: 'msg', name: 'AI', is_user: false }
            }
        ];

        const node = createNode('node1', 5, 'msg', group, allChatLengths);

        expect(node.chat_sessions['chat1.jsonl']).toEqual({
            messageId: 5,
            indexInGroup: 2,
            length: 10
        });
        expect(node.chat_sessions['chat2.jsonl']).toEqual({
            messageId: 5,
            indexInGroup: 2,
            length: 15
        });
    });
});

describe('buildGraph', () => {
    it('should build a simple graph with root node', () => {
        const allChats = [
            [
                {
                    file_name: 'chat1.jsonl',
                    index: 0,
                    message: { mes: 'Hi', name: 'AI', is_user: false, is_system: false }
                }
            ]
        ];

        const allLengths = { 'chat1.jsonl': 1 };
        const { elements } = buildGraph(allChats, allLengths);

        // Should have root node + 1 message node + 1 edge
        const nodes = elements.filter(e => e.group === 'nodes');
        const edges = elements.filter(e => e.group === 'edges');

        expect(nodes.length).toBeGreaterThanOrEqual(2); // root + message
        expect(edges.length).toBeGreaterThanOrEqual(1); // edge from root to message

        // Check root node exists
        const rootNode = nodes.find(n => n.data.id === 'root');
        expect(rootNode).toBeTruthy();
    });

    it('should create edges between messages', () => {
        const allChats = [
            [
                {
                    file_name: 'chat1.jsonl',
                    index: 0,
                    message: { mes: 'msg1', name: 'AI', is_user: false, is_system: false }
                }
            ],
            [
                {
                    file_name: 'chat1.jsonl',
                    index: 1,
                    message: { mes: 'msg2', name: 'User', is_user: true, is_system: false }
                }
            ]
        ];

        const allLengths = { 'chat1.jsonl': 2 };
        const { elements } = buildGraph(allChats, allLengths);

        const edges = elements.filter(e => e.group === 'edges');
        expect(edges.length).toBeGreaterThanOrEqual(2); // At least 2 edges
    });

    it('should handle branching chats', () => {
        const allChats = [
            [
                {
                    file_name: 'chat1.jsonl',
                    index: 0,
                    message: { mes: 'greeting', name: 'AI', is_user: false, is_system: false }
                },
                {
                    file_name: 'chat2.jsonl',
                    index: 0,
                    message: { mes: 'greeting', name: 'AI', is_user: false, is_system: false }
                }
            ],
            [
                {
                    file_name: 'chat1.jsonl',
                    index: 1,
                    message: { mes: 'response1', name: 'User', is_user: true, is_system: false }
                },
                {
                    file_name: 'chat2.jsonl',
                    index: 1,
                    message: { mes: 'response2', name: 'User', is_user: true, is_system: false }
                }
            ]
        ];

        const allLengths = { 'chat1.jsonl': 2, 'chat2.jsonl': 2 };
        const { elements } = buildGraph(allChats, allLengths);

        // Should have 1 shared node for greeting + 2 different response nodes
        const nodes = elements.filter(e => e.group === 'nodes');
        const messageNodes = nodes.filter(n => n.data.id !== 'root');

        expect(messageNodes.length).toBeGreaterThanOrEqual(2);
    });

    it('should extract swipe data', () => {
        const allChats = [
            [
                {
                    file_name: 'chat1.jsonl',
                    index: 0,
                    message: { mes: 'greeting', name: 'AI', is_user: false, is_system: false }
                }
            ],
            [
                {
                    file_name: 'chat1.jsonl',
                    index: 1,
                    message: {
                        mes: 'response1',
                        name: 'AI',
                        is_user: false,
                        is_system: false,
                        swipes: ['response1', 'response2', 'response3']
                    }
                }
            ]
        ];

        const allLengths = { 'chat1.jsonl': 2 };
        const { swipeData } = buildGraph(allChats, allLengths);

        expect(swipeData).toBeTruthy();
        // Swipe data should be associated with parent nodes
        expect(Object.keys(swipeData).length).toBeGreaterThan(0);
    });

    it('should handle empty chat history', () => {
        const { elements } = buildGraph([], {});

        // Should still have root node
        expect(elements.length).toBeGreaterThanOrEqual(1);
        expect(elements[0].data.id).toBe('root');
    });
});

describe('highlightCheckpointPaths', () => {
    it('should not modify elements without checkpoints', () => {
        const elements = [
            { group: 'nodes', data: { id: 'root', name: 'Root' } },
            { group: 'nodes', data: { id: 'msg1', isBookmark: false } },
            { group: 'edges', data: { id: 'edge1', source: 'root', target: 'msg1' } }
        ];

        const result = highlightCheckpointPaths(elements);

        expect(result[2].data.isHighlight).toBeFalsy();
        expect(result[1].data.borderColor).toBeFalsy();
    });

    it('should highlight path from checkpoint to root', () => {
        const checkpointColor = 'rgb(100, 150, 200)';
        const elements = [
            { group: 'nodes', data: { id: 'root', name: 'Root' } },
            { group: 'nodes', data: { id: 'msg1', isBookmark: false } },
            { group: 'nodes', data: { id: 'checkpoint', isBookmark: true, color: checkpointColor, bookmarkName: 'test' } },
            { group: 'edges', data: { id: 'edge1', source: 'root', target: 'msg1' } },
            { group: 'edges', data: { id: 'edge2', source: 'msg1', target: 'checkpoint' } }
        ];

        const result = highlightCheckpointPaths(elements);

        // Find the edge leading to checkpoint
        const highlightedEdge = result.find(e => e.group === 'edges' && e.data.target === 'checkpoint');

        expect(highlightedEdge.data.isHighlight).toBe(true);
        expect(highlightedEdge.data.color).toBe(checkpointColor);
        expect(highlightedEdge.data.bookmarkName).toBe('test');
    });

    it('should stop highlighting at another checkpoint', () => {
        const color1 = 'rgb(100, 100, 100)';
        const color2 = 'rgb(200, 200, 200)';

        const elements = [
            { group: 'nodes', data: { id: 'root' } },
            { group: 'nodes', data: { id: 'checkpoint1', isBookmark: true, color: color1, bookmarkName: 'cp1' } },
            { group: 'nodes', data: { id: 'checkpoint2', isBookmark: true, color: color2, bookmarkName: 'cp2' } },
            { group: 'edges', data: { id: 'edge1', source: 'root', target: 'checkpoint1' } },
            { group: 'edges', data: { id: 'edge2', source: 'checkpoint1', target: 'checkpoint2' } }
        ];

        const result = highlightCheckpointPaths(elements);

        const edge1 = result.find(e => e.data.id === 'edge1');
        const edge2 = result.find(e => e.data.id === 'edge2');

        // edge2 should be highlighted with color2
        expect(edge2.data.color).toBe(color2);

        // edge1 should be highlighted with color1 (from checkpoint1)
        // but NOT with color2 (stops at checkpoint1)
        expect(edge1.data.color).toBe(color1);
    });
});

describe('convertToCytoscapeElements', () => {
    it('should convert simple chat history', () => {
        const chatHistory = {
            'chat1.jsonl': [
                { mes: 'Hello', name: 'AI', is_user: false, is_system: false },
                { mes: 'Hi there', name: 'User', is_user: true, is_system: false }
            ]
        };

        const { elements } = convertToCytoscapeElements(chatHistory);

        expect(elements).toBeTruthy();
        expect(elements.length).toBeGreaterThan(0);

        const nodes = elements.filter(e => e.group === 'nodes');
        const edges = elements.filter(e => e.group === 'edges');

        expect(nodes.length).toBeGreaterThan(1);
        expect(edges.length).toBeGreaterThan(0);
    });

    it('should return both elements and swipe data', () => {
        const chatHistory = {
            'chat1.jsonl': [
                { mes: 'Hello', name: 'AI', is_user: false, is_system: false },
                {
                    mes: 'Response',
                    name: 'AI',
                    is_user: false,
                    is_system: false,
                    swipes: ['Response', 'Alternative']
                }
            ]
        };

        const result = convertToCytoscapeElements(chatHistory);

        expect(result.elements).toBeTruthy();
        expect(result.swipeData).toBeTruthy();
    });

    it('should handle multiple branching chats', () => {
        const chatHistory = {
            'chat1.jsonl': [
                { mes: 'Shared start', name: 'AI', is_user: false, is_system: false },
                { mes: 'Branch 1', name: 'User', is_user: true, is_system: false }
            ],
            'chat2.jsonl': [
                { mes: 'Shared start', name: 'AI', is_user: false, is_system: false },
                { mes: 'Branch 2', name: 'User', is_user: true, is_system: false }
            ]
        };

        const { elements } = convertToCytoscapeElements(chatHistory);

        const nodes = elements.filter(e => e.group === 'nodes');
        const messageNodes = nodes.filter(n => n.data.id !== 'root');

        // Should have shared node + 2 branch nodes = 3 total
        expect(messageNodes.length).toBeGreaterThanOrEqual(2);
    });

    it('should apply checkpoint highlighting', () => {
        const chatHistory = {
            'chat1.jsonl': [
                { mes: 'Start', name: 'AI', is_user: false, is_system: false },
                {
                    mes: 'Checkpoint',
                    name: 'System',
                    is_system: true,
                    extra: { bookmark_link: 'checkpoint_chat' }
                }
            ],
            'checkpoint_chat.jsonl': [
                { mes: 'Start', name: 'AI', is_user: false, is_system: false }
            ]
        };

        const { elements } = convertToCytoscapeElements(chatHistory);

        const checkpointNode = elements.find(e =>
            e.group === 'nodes' && e.data.isBookmark
        );

        expect(checkpointNode).toBeTruthy();
        expect(checkpointNode.data.color).toBeTruthy();
    });
});
