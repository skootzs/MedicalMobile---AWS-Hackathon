// packages/schema/package.json is 0 bytes until R4 publishes a real manifest, and Node
// refuses to load any module under an invalid package.json. Copy the one source file.
// TODO(R4): delete this and import @cht-nocode/schema once the manifest exists.
import { copyFileSync, mkdirSync } from 'node:fs';

const source = new URL('../../packages/schema/src/handoffs.ts', import.meta.url);
const targetDir = new URL('../src/generated/', import.meta.url);
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, new URL('handoffs.ts', targetDir));
