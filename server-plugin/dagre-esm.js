/**
 * ES Module wrapper for bundled dagre.js (CommonJS)
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Load the CommonJS dagre bundle
const dagre = require('./dagre.js');

export default dagre;
