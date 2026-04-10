import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubs = (name) => path.resolve(__dirname, `test/stubs/${name}.stub.js`);

// The extension files assume they're installed inside SillyTavern's directory tree
// (e.g. public/extensions/SillyTavern-Timelines/). When running from the repo root,
// relative imports like '../../../../script.js' must be redirected to local stubs.
// Vite checks aliases against the raw import specifier string, so we use the exact
// relative path strings as written in the source files.
const resolvedSillyTavernImports = [
    ['../../../../script.js', stubs('script')],
    ['../../../extensions.js', stubs('extensions')],
    ['../../../power-user.js', stubs('power-user')],
    ['../../../bookmarks.js', stubs('bookmarks')],
    ['../../../tokenizers.js', stubs('tokenizers')],
    ['../../../utils.js', stubs('utils')],
    ['../../../slash-commands.js', stubs('slash-commands')],
    ['../../../loader.js', stubs('loader')],
];

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.js'],
        benchmark: {
            include: ['test/**/*.bench.js'],
        },
    },
    resolve: {
        alias: resolvedSillyTavernImports.map(([find, replacement]) => ({ find, replacement })),
    },
});
