/**
 * Schema and validation for SillyTavern chat fixture data.
 *
 * A fixture is: { [filename: string]: ChatMessage[] }
 * where filename has a .jsonl extension and each ChatMessage
 * matches the fields read by buildGraph / createNode.
 */

/**
 * Validate a single chat message object.
 * @param {*} msg
 * @param {string} context - For error messages
 * @returns {string[]} Array of validation errors (empty = valid)
 */
function validateMessage(msg, context) {
    const errors = [];

    if (typeof msg !== 'object' || msg === null) {
        return [`${context}: message must be an object`];
    }

    // Required string fields
    for (const field of ['mes', 'name', 'send_date']) {
        if (typeof msg[field] !== 'string') {
            errors.push(`${context}: '${field}' must be a string, got ${typeof msg[field]}`);
        }
    }

    // Required boolean fields
    for (const field of ['is_user', 'is_system', 'is_name']) {
        if (typeof msg[field] !== 'boolean') {
            errors.push(`${context}: '${field}' must be a boolean, got ${typeof msg[field]}`);
        }
    }

    // Optional swipes
    if (msg.swipes !== undefined) {
        if (!Array.isArray(msg.swipes)) {
            errors.push(`${context}: 'swipes' must be an array`);
        } else {
            msg.swipes.forEach((s, i) => {
                if (typeof s !== 'string') {
                    errors.push(`${context}: swipes[${i}] must be a string`);
                }
            });
        }
        if (msg.swipe_id !== undefined) {
            if (typeof msg.swipe_id !== 'number' || !Number.isInteger(msg.swipe_id)) {
                errors.push(`${context}: 'swipe_id' must be an integer`);
            } else if (Array.isArray(msg.swipes) && msg.swipe_id >= msg.swipes.length) {
                errors.push(`${context}: swipe_id ${msg.swipe_id} out of range (swipes.length=${msg.swipes.length})`);
            }
        }
    }

    // Optional extra
    if (msg.extra !== undefined) {
        if (typeof msg.extra !== 'object' || msg.extra === null) {
            errors.push(`${context}: 'extra' must be an object`);
        } else if (msg.extra.bookmark_link !== undefined) {
            if (typeof msg.extra.bookmark_link !== 'string') {
                errors.push(`${context}: 'extra.bookmark_link' must be a string`);
            }
        }
    }

    return errors;
}

/**
 * Validate an entire fixture (chat dictionary).
 * @param {*} fixture
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateFixture(fixture) {
    const errors = [];

    if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
        return { valid: false, errors: ['fixture must be a non-null, non-array object'] };
    }

    for (const [filename, messages] of Object.entries(fixture)) {
        if (!filename.endsWith('.jsonl')) {
            errors.push(`Key '${filename}' must end with .jsonl`);
        }

        if (!Array.isArray(messages)) {
            errors.push(`'${filename}': value must be an array of messages`);
            continue;
        }

        messages.forEach((msg, i) => {
            const msgErrors = validateMessage(msg, `${filename}[${i}]`);
            errors.push(...msgErrors);
        });
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Assert a fixture is valid, throwing with details if not.
 * @param {*} fixture
 */
export function assertValidFixture(fixture) {
    const { valid, errors } = validateFixture(fixture);
    if (!valid) {
        throw new Error(`Invalid fixture:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    }
}
