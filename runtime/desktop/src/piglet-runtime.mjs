import crypto from 'node:crypto';
import { inspectPigletBytes, normalizePigletBytes } from './piglet-package.mjs';

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

export async function loadPigletResource(context, rawId) {
  const child = pigletChild(context, rawId);
  const loaded = await context.reader.read(child.entry, { verify: true });
  if (!loaded) throw new Error(`Piglet child is unavailable: ${child.id}`);
  const digest = crypto.createHash('sha256').update(loaded.data).digest('hex');
  if (digest !== child.sha256) throw new Error(`Piglet child integrity failed: ${child.id}`);
  return { child, data: loaded.data };
}

export function createDesktopPigletRuntime({ ipcMain, assertWurstSender, assertCapability, storage, surfaces }) {
  async function resolve(context, rawRef) {
    const ref = String(rawRef ?? '');
    if (ref.startsWith('wurstfs:') || ref.startsWith('/data/') || ref.startsWith('data/')) {
      const path = ref.startsWith('wurstfs:') ? ref.slice('wurstfs:'.length) : ref;
      const data = await storage.readFile(context, path);
      const descriptor = await inspectPigletBytes(data, {
        ref: `wurstfs:${path.startsWith('/') ? path : `/${path}`}`,
        id: path.startsWith('/') ? path : `/${path}`,
        label: null,
        source: 'wurstfs',
        path: path.startsWith('/') ? path : `/${path}`,
        mutable: true
      });
      descriptor.label = descriptor.application?.name ?? descriptor.path.split('/').at(-1);
      return { descriptor, data };
    }
    const loaded = await loadPigletResource(context, ref);
    const inspected = await inspectPigletBytes(loaded.data, {
      ...loaded.child,
      ref: `builtin:${loaded.child.id}`,
      source: 'builtin',
      mutable: false
    });
    return { descriptor: { ...loaded.child, ...inspected }, data: loaded.data };
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
    const clean = resolved.descriptor.path.replace(/^\/data\//, '');
    return `wurst://data/${clean.split('/').map(encodeURIComponent).join('/')}`;
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
    if (descriptor.source !== 'wurstfs') throw new Error('Built-in Piglets are immutable package content and cannot be removed at runtime');
    return storage.remove(context, descriptor.ref);
  });
  ipcMain.handle('wurst:piglet:open', async (event, ref, options = {}) => {
    const context = assertWurstSender(event);
    assertCapability(context, 'piglet');
    const { descriptor, data } = await resolve(context, ref);
    return surfaces.open(context, descriptor, data, options);
  });
  ipcMain.handle('wurst:piglet:surfaces', async (event) => surfaces.list(assertWurstSender(event)));
  ipcMain.handle('wurst:piglet:bounds', async (event, handle, bounds) => surfaces.setBounds(assertWurstSender(event), handle, bounds));
  ipcMain.handle('wurst:piglet:focus', async (event, handle) => surfaces.focus(assertWurstSender(event), handle));
  ipcMain.handle('wurst:piglet:close', async (event, handle) => surfaces.close(assertWurstSender(event), handle));

  return { resolve, list, closeContext: surfaces.closeContext, closeChildContext: surfaces.closeChildContext, layoutFillSurfaces: surfaces.layoutFillSurfaces };
}

export function registerDesktopPigletRuntime(options) {
  return createDesktopPigletRuntime(options);
}
