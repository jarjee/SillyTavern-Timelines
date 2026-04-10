/**
 * Generates test fixtures for SillyTavern-Timelines using Claude Haiku.
 *
 * Usage:
 *   node test/generate-fixtures.js              # generate all scenarios
 *   node test/generate-fixtures.js <name>       # generate matching scenario(s)
 *
 * Requires ANTHROPIC_API_KEY environment variable.
 * Generated fixtures are committed to the repo so tests don't need an API key to run.
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assertValidFixture } from './fixtures/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const MODEL = 'claude-haiku-4-5';
const MAX_RETRIES = 3;

const client = new Anthropic();

// Structured output schema.
// We use a wrapper format ({files: [...]}) since JSON schema doesn't allow
// dynamic object keys for the chat_dict format. We transform after generation.
// Optional fields use sentinels (empty array, -1, empty string) to avoid
// nullable/anyOf complexity.
const FIXTURE_SCHEMA = {
    type: 'object',
    properties: {
        files: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    filename: {
                        type: 'string',
                        description: 'Chat filename without extension, e.g. "chat_main" (NOT "chat_main.jsonl")',
                    },
                    messages: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                mes: { type: 'string', description: 'The message text content' },
                                name: { type: 'string', description: 'Speaker name' },
                                is_user: { type: 'boolean', description: 'True if message is from human user' },
                                is_system: { type: 'boolean', description: 'True if message is a system notification (not AI or user)' },
                                is_name: { type: 'boolean', description: 'True if the name should be displayed (usually true)' },
                                send_date: { type: 'string', description: 'Date string, e.g. "January 1, 2024  12:00:00"' },
                                swipes: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Alternate response texts. Empty array if no swipes. Must include the current mes value as one element.',
                                },
                                swipe_id: {
                                    type: 'integer',
                                    description: 'Index of current swipe in the swipes array. Use -1 if no swipes.',
                                },
                                extra_bookmark_link: {
                                    type: 'string',
                                    description: 'Filename (without .jsonl) of the branch chat this message checkpoints to. Empty string if not a checkpoint.',
                                },
                            },
                            required: ['mes', 'name', 'is_user', 'is_system', 'is_name', 'send_date', 'swipes', 'swipe_id', 'extra_bookmark_link'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['filename', 'messages'],
                additionalProperties: false,
            },
        },
    },
    required: ['files'],
    additionalProperties: false,
};

/**
 * Scenario definitions. Each produces one fixture JSON file.
 * Prompts are very specific about structural constraints so Haiku
 * produces data that exercises the exact code paths we need to test.
 */
const SCENARIOS = [
    {
        name: 'simple-branching',
        description: 'Basic DAG deduplication: shared prefix, then branching',
        prompt: `Generate a SillyTavern chat fixture with exactly 3 chat files.
The scenario: A user is talking to an AI character named "Aria". All 3 chats start
with exactly the same first 2 messages (AI greeting, then user response), then diverge
into 3 different conversations from message index 2 onwards. Each chat has 5 messages total.

File structure:
- chat_A.jsonl: 5 messages (the full conversation)
- chat_B.jsonl: 5 messages (same first 2 as A, different messages 2-4)
- chat_C.jsonl: 5 messages (same first 2 as A, different messages 2-4)

IMPORTANT constraints:
- The EXACT text of messages[0] and messages[1] must be identical across all 3 files.
- Messages 2-4 must be completely different text in each file.
- All AI messages: is_user=false, is_system=false, is_name=true
- All user messages: is_user=true, is_system=false, is_name=true
- Alternate AI and user messages. Start with AI.
- No swipes (swipes=[], swipe_id=-1) and no bookmarks (extra_bookmark_link="").
- Send dates should increment by 1 minute per message within each file.`,
    },
    {
        name: 'deep-conversation',
        description: 'Single long chat for depth handling',
        prompt: `Generate a SillyTavern chat fixture with exactly 1 chat file named "chat_main".
The scenario: A long philosophical conversation between a user and an AI named "Philosopher"
about the nature of consciousness. The chat has exactly 22 messages, strictly alternating
between AI and user, starting with AI.

IMPORTANT constraints:
- Exactly 1 file: chat_main
- Exactly 22 messages
- Messages strictly alternate: AI, User, AI, User, ...
- All AI messages: is_user=false, is_system=false, is_name=true, name="Philosopher"
- All user messages: is_user=true, is_system=false, is_name=true, name="User"
- No swipes (swipes=[], swipe_id=-1) and no bookmarks (extra_bookmark_link="").
- Messages should form a coherent, escalating philosophical discussion.
- Send dates: start at "January 15, 2024  09:00:00" and increment by 2 minutes per message.`,
    },
    {
        name: 'checkpoint-tree',
        description: 'Checkpoint/bookmark detection and path highlighting',
        prompt: `Generate a SillyTavern chat fixture with exactly 2 chat files.
The scenario: A user talking to an AI named "Storyteller" about an adventure story.
At message index 4 (5th message, 0-indexed), the main chat has a checkpoint that
creates a branch chat.

File structure:
- chat_main.jsonl: 9 messages total
  - messages[0..3]: 4 normal alternating messages (AI, User, AI, User)
  - messages[4]: A SYSTEM checkpoint message marking the branch point
  - messages[5..8]: 4 more alternating messages continuing the main story

- chat_branch.jsonl: 7 messages total
  - messages[0..3]: EXACT COPIES of chat_main.jsonl messages[0..3] (identical text)
  - messages[4]: EXACT COPY of chat_main.jsonl messages[4] (the checkpoint system message)
  - messages[5..6]: 2 new alternating messages (AI then User) taking the story in a different direction

The checkpoint message (messages[4] in both files) must be:
  - is_system=true, is_user=false, is_name=false
  - name="System"
  - mes="[Checkpoint created]"
  - extra_bookmark_link="chat_branch" (this links to the branch file)
  - swipes=[], swipe_id=-1

IMPORTANT: The first 5 messages (index 0-4) must have IDENTICAL text in both files.
Normal messages: is_user alternates (AI first), is_system=false, is_name=true.
No swipes on any message. Send dates: chat_main starts Jan 20 2024 14:00:00, chat_branch starts Jan 20 2024 14:00:00 (same, since it's a branch).`,
    },
    {
        name: 'swipe-heavy',
        description: 'Swipe nodes/edges creation',
        prompt: `Generate a SillyTavern chat fixture with exactly 1 chat file named "chat_main".
The scenario: A user talking to an AI named "Writer" about creative writing. The AI
provides multiple response options (swipes) for some of its turns.

The chat has exactly 10 messages:
- messages[0]: AI greeting (no swipes - swipes are never added to index 0)
- messages[1]: User response (no swipes - users don't have swipes)
- messages[2]: AI response WITH 4 swipes (the current mes plus 3 alternates)
- messages[3]: User response (no swipes)
- messages[4]: AI response WITH 3 swipes (the current mes plus 2 alternates)
- messages[5]: User response (no swipes)
- messages[6]: AI response WITH 4 swipes (the current mes plus 3 alternates)
- messages[7]: User response (no swipes)
- messages[8]: AI response (no swipes)
- messages[9]: User response (no swipes)

IMPORTANT constraints for swipe messages:
- swipes array MUST include the current mes value as one of its elements
- swipe_id must be the index of the current mes within the swipes array (typically 0)
- Swipe texts should be meaningfully different alternative responses
- All AI messages: is_user=false, is_system=false, is_name=true, name="Writer"
- All user messages: is_user=true, is_system=false, is_name=true, name="User"
- No bookmarks (extra_bookmark_link="").
- Send dates start at "February 1, 2024  10:00:00" incrementing by 3 minutes.`,
    },
    {
        name: 'multi-character',
        description: 'Multiple AI character names in root node',
        prompt: `Generate a SillyTavern chat fixture with exactly 3 chat files.
The scenario: A user has chatted with 3 different AI characters: "Alice", "Bob", and "Carol".
The chats share a common opening but use different character names.

File structure:
- chat_alice.jsonl: 4 messages. AI character named "Alice".
- chat_bob.jsonl: 4 messages. AI character named "Bob".
- chat_carol.jsonl: 4 messages. AI character named "Carol".

IMPORTANT constraints:
- All 3 files must have IDENTICAL text for messages[0] and messages[1].
  (These are the shared prefix messages.)
- messages[0] is an AI greeting (generic enough to fit any character name but use the correct character name in the 'name' field).
  Wait - actually: messages[0] and messages[1] must have IDENTICAL mes TEXT across all 3 files,
  but the 'name' field in messages[0] will differ (Alice vs Bob vs Carol).
  Hmm, but for deduplication, the code checks only 'mes' text, not 'name'. So the same mes text
  at the same depth merges to one node. So the greeting text in messages[0] should be generic
  and identical, but the name field differs. That's fine.
- messages[2] and messages[3] can differ across files.
- No swipes (swipes=[], swipe_id=-1) and no bookmarks (extra_bookmark_link="").
- User messages: is_user=true, is_system=false, is_name=true, name="User"
- AI messages: is_user=false, is_system=false, is_name=true
- Alternating messages: AI, User, AI, User. Start with AI.
- Send dates: start at "March 1, 2024  08:00:00" for all files, incrementing by 1 minute.`,
    },
    {
        name: 'complex-tree',
        description: 'Full integration scenario: branching, checkpoints, and swipes',
        prompt: `Generate a SillyTavern chat fixture with 5 chat files representing a complex
conversation tree. An AI character named "Guide" is leading a user through a choose-your-own
adventure story.

File structure:
- chat_root.jsonl: 8 messages
  - messages[0..1]: Opening exchange (AI greeting, user response) - these will be the shared root
  - messages[2..3]: 2 more messages developing the story
  - messages[4]: SYSTEM checkpoint pointing to "chat_branch_A" (is_system=true, name="System", extra_bookmark_link="chat_branch_A")
  - messages[5..7]: 3 more messages continuing the main story after branch point

- chat_branch_A.jsonl: 7 messages (branches from chat_root at index 4)
  - messages[0..4]: EXACT COPIES of chat_root.jsonl messages[0..4]
  - messages[5..6]: New story direction for branch A (AI then User)

- chat_branch_B.jsonl: 6 messages (shares only messages[0..1] with others)
  - messages[0..1]: EXACT COPIES of chat_root messages[0..1]
  - messages[2..5]: Completely different story path, no checkpoint

- chat_swipe_demo.jsonl: 5 messages (shares messages[0..1] with others)
  - messages[0..1]: EXACT COPIES of chat_root messages[0..1]
  - messages[2]: AI message WITH 3 swipes (mes + 2 alternates, swipe_id=0)
  - messages[3]: User message (no swipes)
  - messages[4]: AI message WITH 2 swipes (mes + 1 alternate, swipe_id=0)

- chat_solo.jsonl: 4 messages (shares only messages[0] with others)
  - messages[0]: EXACT COPY of chat_root messages[0]
  - messages[1..3]: Completely different path, no checkpoint, no swipes

IMPORTANT: Messages that are "EXACT COPIES" must have absolutely identical 'mes' field text.
Checkpoint system message format: is_system=true, is_user=false, is_name=false, name="System", swipes=[], swipe_id=-1.
Normal messages: AI is is_user=false, is_system=false, is_name=true; User is is_user=true, is_system=false, is_name=true.
All AI messages use name="Guide". All user messages use name="User".
Send dates: start at "April 1, 2024  15:00:00" incrementing by 2 minutes per message per file.`,
    },
];

/**
 * Transform the wrapper format returned by the API to the expected fixture format.
 * {files: [{filename, messages}]} -> {filename.jsonl: [messages]}
 */
function transformResponse(parsed) {
    const fixture = {};
    for (const file of parsed.files) {
        const filename = file.filename.endsWith('.jsonl') ? file.filename : `${file.filename}.jsonl`;
        fixture[filename] = file.messages.map(msg => {
            const result = {
                mes: msg.mes,
                name: msg.name,
                is_user: msg.is_user,
                is_system: msg.is_system,
                is_name: msg.is_name,
                send_date: msg.send_date,
            };
            if (msg.swipes && msg.swipes.length > 0) {
                result.swipes = msg.swipes;
                result.swipe_id = msg.swipe_id >= 0 ? msg.swipe_id : 0;
            }
            if (msg.extra_bookmark_link) {
                result.extra = { bookmark_link: msg.extra_bookmark_link };
            }
            return result;
        });
    }
    return fixture;
}

async function generateFixture(scenario) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await client.messages.create({
                model: MODEL,
                max_tokens: 8192,
                output_config: {
                    format: {
                        type: 'json_schema',
                        schema: FIXTURE_SCHEMA,
                    },
                },
                messages: [{
                    role: 'user',
                    content: scenario.prompt,
                }],
            });

            if (response.stop_reason !== 'end_turn') {
                throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
            }

            const textBlock = response.content.find(b => b.type === 'text');
            if (!textBlock) throw new Error('No text block in response');

            const parsed = JSON.parse(textBlock.text);
            const fixture = transformResponse(parsed);
            assertValidFixture(fixture);
            return fixture;
        } catch (err) {
            console.warn(`  Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
            lastError = err;
            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    throw lastError;
}

async function main() {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('Error: ANTHROPIC_API_KEY environment variable is required');
        process.exit(1);
    }

    const filter = process.argv[2];
    const toRun = filter
        ? SCENARIOS.filter(s => s.name.includes(filter))
        : SCENARIOS;

    if (toRun.length === 0) {
        console.error(`No scenarios match filter: ${filter}`);
        console.error('Available:', SCENARIOS.map(s => s.name).join(', '));
        process.exit(1);
    }

    console.log(`Generating ${toRun.length} fixture(s) using ${MODEL}...`);
    let failed = 0;

    for (const scenario of toRun) {
        process.stdout.write(`  ${scenario.name} (${scenario.description})... `);
        try {
            const fixture = await generateFixture(scenario);
            const outputPath = join(FIXTURES_DIR, `${scenario.name}.json`);
            writeFileSync(outputPath, JSON.stringify(fixture, null, 2) + '\n');
            const fileCount = Object.keys(fixture).length;
            const msgCount = Object.values(fixture).reduce((sum, msgs) => sum + msgs.length, 0);
            console.log(`done (${fileCount} files, ${msgCount} messages)`);
        } catch (err) {
            console.log(`FAILED`);
            console.error(`    ${err.message}`);
            failed++;
        }
    }

    if (failed > 0) {
        console.error(`\n${failed} fixture(s) failed to generate`);
        process.exit(1);
    }

    console.log('\nAll fixtures generated successfully.');
    console.log('Run "npm test" to verify tests pass with the new fixtures.');
}

main();
