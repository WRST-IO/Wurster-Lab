import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export async function createPigletBackingFile(bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-piglet-'));
  const filePath = path.join(directory, `child-${crypto.randomUUID()}.wurst`);
  await fs.writeFile(filePath, bytes, { mode: 0o600 });
  return {
    filePath,
    async bytes() { return fs.readFile(filePath); },
    async destroy() { await fs.rm(directory, { recursive: true, force: true }); }
  };
}
