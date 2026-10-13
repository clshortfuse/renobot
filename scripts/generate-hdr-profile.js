import { writeFile } from 'node:fs/promises';
import { buildHdrProfile } from '../src/hdr-profile.js';

const output = process.argv[2];
if (!output) throw new Error('An output header path is required');
const bytes = Array.from(buildHdrProfile(), (value) => `0x${value.toString(16).padStart(2, '0')}`);
await writeFile(output, `static constexpr unsigned char hdrICC[] = {${bytes.join(',')}};\n`);