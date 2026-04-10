import { describe, it, expect } from 'vitest';
import { _testExports as server } from '../../server-plugin/index.js';
import { _testExports as client } from '../../tl_node_data.js';

// Both implementations should be identical - test both
const impls = [
    { name: 'server', ...server },
    { name: 'client', ...client },
];

const makeMsg = (mes, extras = {}) => ({
    mes,
    name: 'Bot',
    is_user: false,
    is_system: false,
    is_name: true,
    send_date: 'Jan 1',
    ...extras,
});

for (const impl of impls) {
    describe(`preprocessChatSessions [${impl.name}]`, () => {
        it('transposes file-keyed to depth-keyed structure', () => {
            const input = {
                'chat_A.jsonl': [makeMsg('Hello'), makeMsg('World')],
                'chat_B.jsonl': [makeMsg('Hi'), makeMsg('There')],
            };
            const result = impl.preprocessChatSessions(input);

            expect(result).toHaveLength(2);
            // depth 0: both files
            expect(result[0]).toHaveLength(2);
            expect(result[0].map(o => o.file_name)).toContain('chat_A.jsonl');
            expect(result[0].map(o => o.file_name)).toContain('chat_B.jsonl');
            expect(result[0].find(o => o.file_name === 'chat_A.jsonl').message.mes).toBe('Hello');
            // depth 1
            expect(result[1]).toHaveLength(2);
        });

        it('each entry has {file_name, index, message}', () => {
            const input = { 'chat.jsonl': [makeMsg('msg0'), makeMsg('msg1')] };
            const result = impl.preprocessChatSessions(input);
            expect(result[0][0]).toMatchObject({ file_name: 'chat.jsonl', index: 0 });
            expect(result[1][0]).toMatchObject({ file_name: 'chat.jsonl', index: 1 });
        });

        it('handles chats of different lengths', () => {
            const input = {
                'short.jsonl': [makeMsg('A')],
                'long.jsonl': [makeMsg('A'), makeMsg('B'), makeMsg('C')],
            };
            const result = impl.preprocessChatSessions(input);
            expect(result).toHaveLength(3);
            expect(result[0]).toHaveLength(2); // both files at depth 0
            expect(result[1]).toHaveLength(1); // only long.jsonl at depth 1
            expect(result[2]).toHaveLength(1); // only long.jsonl at depth 2
        });

        it('handles empty input', () => {
            const result = impl.preprocessChatSessions({});
            expect(result).toEqual([]);
        });

        it('single chat file', () => {
            const input = { 'chat.jsonl': [makeMsg('only')] };
            const result = impl.preprocessChatSessions(input);
            expect(result).toHaveLength(1);
            expect(result[0]).toHaveLength(1);
        });
    });

    describe(`groupMessagesByContent [${impl.name}]`, () => {
        it('groups identical messages together', () => {
            const messages = [
                { file_name: 'A.jsonl', index: 0, message: { mes: 'Hello' } },
                { file_name: 'B.jsonl', index: 1, message: { mes: 'Hello' } },
                { file_name: 'C.jsonl', index: 2, message: { mes: 'Different' } },
            ];
            const groups = impl.groupMessagesByContent(messages);
            expect(Object.keys(groups)).toHaveLength(2);
            expect(groups['Hello']).toHaveLength(2);
            expect(groups['Different']).toHaveLength(1);
        });

        it('normalizes \\r\\n to \\n before grouping', () => {
            const messages = [
                { file_name: 'A.jsonl', index: 0, message: { mes: 'Hello\r\nWorld' } },
                { file_name: 'B.jsonl', index: 1, message: { mes: 'Hello\nWorld' } },
            ];
            const groups = impl.groupMessagesByContent(messages);
            // After normalization both become 'Hello\nWorld'
            expect(Object.keys(groups)).toHaveLength(1);
            expect(groups['Hello\nWorld']).toHaveLength(2);
        });

        it('normalizes the mes field in-place', () => {
            const msg = { mes: 'Line1\r\nLine2' };
            const messages = [{ file_name: 'A.jsonl', index: 0, message: msg }];
            impl.groupMessagesByContent(messages);
            expect(msg.mes).toBe('Line1\nLine2');
        });

        it('different messages at same depth create separate groups', () => {
            const messages = [
                { file_name: 'A.jsonl', index: 0, message: { mes: 'Response A' } },
                { file_name: 'B.jsonl', index: 1, message: { mes: 'Response B' } },
            ];
            const groups = impl.groupMessagesByContent(messages);
            expect(Object.keys(groups)).toHaveLength(2);
        });

        it('returns empty object for empty input', () => {
            const groups = impl.groupMessagesByContent([]);
            expect(groups).toEqual({});
        });
    });
}
