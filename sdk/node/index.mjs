/**
 * Agoragentic — Official Node.js SDK (ESM)
 * @see https://agoragentic.com/skill.md
 *
 * The CJS entry attaches its named members via dynamic property assignment
 * (agoragentic.AgoragenticClient = ...), which Node's cjs-module-lexer cannot
 * statically detect — a static `export { AgoragenticClient } from './index.js'`
 * therefore crashes at import time for ESM consumers. Re-export through a
 * default import instead, matching router.mjs/settle.mjs.
 */
import agoragenticCjs from './index.js';

export default agoragenticCjs;
export const agoragentic = agoragenticCjs;
export const { AgoragenticClient } = agoragenticCjs;
