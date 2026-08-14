import { inspectPigletBytes, inspectPigletSource, normalizePigletBytes } from './piglet-package.mjs';

export function pigletChildren(context) {
  return structuredClone(context.manifest.piglet?.children ?? []).map((child) => ({
    ...child,
    ref: `builtin:${child.id}`,
    source: 'builtin',
    mutable: false,
    signature: child.signature ?? null
  }));
}

export function pigletChild(context, rawId) {
  const raw = String(rawId ?? '');
  const id = raw.startsWith('builtin:') ? raw.slice('builtin:'.length) : raw;
  const child = pigletChildren(context).find((item) => item.id === id);
  if (!child) throw new Error(`Unknown Piglet child: ${id}`);
  const entry = context.reader.entry(child.entry);
  if (!entry || entry.scope !== 'piglet' || entry.encryption) throw new Error(`Piglet child is unavailable: ${id}`);
  return child;
}

export function openPigletResourceSource(context, rawId) {
  const child = pigletChild(context, rawId);
  const entry = context.reader.entry(child.entry);
  const source = {
    size: entry.length,
    async read(offset, length) {
      const loaded = await context.reader.readRange(child.entry, offset, length, { verify: true });
      if (!loaded || loaded.data.length !== length) throw new Error(`Piglet child range is unavailable: ${child.id}`);
      return loaded.data;
    }
  };
  return { child, source };
}

export async function loadPigletResource(context, rawId) {
  const { child, source } = openPigletResourceSource(context, rawId);
  const chunks = [];
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < source.size; offset += chunkSize) chunks.push(Buffer.from(await source.read(offset, Math.min(chunkSize, source.size - offset))));
  return { child, data: Buffer.concat(chunks, source.size) };
}

export function createDesktopPigletRuntime({ ipcMain, assertWurstSender, assertCapability, storage, embeds }) {
  async function resolve(context, rawRef) {
    const ref = String(rawRef ?? '');
    if (ref.startsWith('wurst://app/')) {
      const parsed = new URL(ref);
      const resourcePath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      const entry = context.reader.entry(resourcePath);
      if (!entry || (entry.scope ?? 'app') !== 'app' || entry.encryption) throw new Error(`Embedded Wurst resource is unavailable: ${resourcePath}`);
      const source = {
        size: entry.length,
        async read(offset, length) {
          const loaded = await context.reader.readRange(resourcePath, offset, length, { verify: true });
          if (!loaded || loaded.data.length !== length) throw new Error(`Embedded Wurst resource range is unavailable: ${resourcePath}`);
          return loaded.data;
        }
      };
      const descriptor = await inspectPigletSource(source, {
        ref, id: resourcePath, label: null, source: 'resource', path: resourcePath, mutable: false, sha256: entry.sha256 ?? null
      });
      descriptor.label = descriptor.application?.name ?? resourcePath.split('/').at(-1);
      return { descriptor, source };
    }
    if (ref.startsWith('wurst://piglet/')) {
      const parsed = new URL(ref);
      return resolve(context, `builtin:${decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).replace(/\.wurst$/i, '')}`);
    }
    if (ref.startsWith('wurst://pigfs/')) {
      const parsed = new URL(ref);
      return resolve(context, `pigfs:/${decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))}`);
    }
    if (ref.startsWith('pigfs:') || ref.startsWith('/') || ref.startsWith('data/')) {
      const path = ref.startsWith('pigfs:') ? ref.slice('pigfs:'.length) : ref;
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const source = await storage.openSource(context, normalizedPath);
      const descriptor = await inspectPigletSource(source, {
        ref: `pigfs:${normalizedPath}`,
        id: normalizedPath,
        label: null,
        source: 'pigfs',
        path: normalizedPath,
        mutable: true
      });
      descriptor.label = descriptor.application?.name ?? descriptor.path.split('/').at(-1);
      return { descriptor, source };
    }
    const loaded = openPigletResourceSource(context, ref);
    const inspected = await inspectPigletSource(loaded.source, {
      ...loaded.child,
      sha256: loaded.child.sha256,
      ref: `builtin:${loaded.child.id}`,
      source: 'builtin',
      mutable: false
    });
    return { descriptor: { ...loaded.child, ...inspected }, source: loaded.source };
  }

  async function list(context) {
    const builtins = [];
    for (const child of pigletChildren(context)) {
      try {
        const { descriptor } = await resolve(context, child.ref);
        builtins.push(descriptor);
      } catch {
        builtins.push(child);
      }
    }
    return [...builtins, ...await storage.discover(context)];
  }

  ipcMain.handle('wurst:piglet:children', async (event) => list(assertWurstSender(event)));
  ipcMain.handle('wurst:piglet:url', async (event, ref) => {
    const context = assertWurstSender(event);
    const resolved = await resolve(context, ref);
    if (resolved.descriptor.source === 'builtin') return `wurst://piglet/${encodeURIComponent(resolved.descriptor.id)}.wurst`;
    const clean = String(resolved.descriptor.path || '').replace(/^\/+/, '');
    return `wurst://pigfs/${clean.split('/').map(encodeURIComponent).join('/')}`;
  });
  ipcMain.handle('wurst:piglet:inspect', async (event, ref) => (await resolve(assertWurstSender(event), ref)).descriptor);
  ipcMain.handle('wurst:piglet:install', async (event, name, payload, options = {}) => {
    const context = assertWurstSender(event);
    assertCapability(context, 'piglet');
    return storage.install(context, normalizePigletBytes(payload), { ...options, name });
  });
  ipcMain.handle('wurst:piglet:remove', async (event, ref) => {
    const context = assertWurstSender(event);
    assertCapability(context, 'piglet');
    const descriptor = (await resolve(context, ref)).descriptor;
    if (descriptor.source !== 'pigfs') throw new Error('Built-in Piglets are immutable package content and cannot be removed at runtime');
    return storage.remove(context, descriptor.ref);
  });
  ipcMain.handle('wurst:piglet:embed-open', async (event, ref, options = {}) => {
    const context = assertWurstSender(event);
    assertCapability(context, 'piglet');
    const { descriptor, source } = await resolve(context, ref);
    return embeds.open(context, descriptor, source, options);
  });
  ipcMain.handle('wurst:piglet:embed-read', async (event, handle, offset, length) => embeds.read(assertWurstSender(event), handle, offset, length));
  ipcMain.handle('wurst:piglet:embed-persist', async (event, handle, payload) => embeds.persist(assertWurstSender(event), handle, payload));
  ipcMain.handle('wurst:piglet:embed-invoke', async (event, handle, method, args = []) => embeds.invoke(assertWurstSender(event), handle, method, args));
  ipcMain.handle('wurst:piglet:embed-close', async (event, handle) => embeds.close(assertWurstSender(event), handle));


  return { resolve, list, closeContext: embeds.closeContext };
}

export function registerDesktopPigletRuntime(options) {
  return createDesktopPigletRuntime(options);
}
