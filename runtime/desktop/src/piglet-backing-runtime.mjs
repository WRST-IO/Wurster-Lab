import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export async function createPigletBackingFile(bytes) {
  return createPigletBackingFileFromSource({
    size: bytes.length,
    async read(offset, length) { return bytes.subarray(offset, offset + length); }
  });
}

export async function createPigletBackingFileFromSource(source, { chunkSize = 4 * 1024 * 1024 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-piglet-'));
  const filePath = path.join(directory, `child-${crypto.randomUUID()}.wurst`);
  const handle = await fs.open(filePath, 'w', 0o600);
  try {
    for (let offset = 0; offset < source.size; offset += chunkSize) {
      const chunk = Buffer.from(await source.read(offset, Math.min(chunkSize, source.size - offset)));
      await handle.write(chunk, 0, chunk.length, offset);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    filePath,
    async bytes() { return fs.readFile(filePath); },
    async destroy() { await fs.rm(directory, { recursive: true, force: true }); }
  };
}
