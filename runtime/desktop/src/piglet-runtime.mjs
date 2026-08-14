import crypto from 'node:crypto';

export function pigletChildren(context) {
  return structuredClone(context.manifest.piglet?.children ?? []);
}

export function pigletChild(context, rawId) {
  const id = String(rawId ?? '');
  const child = pigletChildren(context).find((item) => item.id === id);
  if (!child) throw new Error(`Unknown Piglet child: ${id}`);
  const entry = context.reader.entry(child.entry);
  if (!entry || entry.scope !== 'piglet' || entry.encryption) {
    throw new Error(`Piglet child is unavailable: ${id}`);
  }
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

export function registerDesktopPigletRuntime({ ipcMain, assertWurstSender }) {
  ipcMain.handle('wurst:piglet:children', async (event) => {
    return pigletChildren(assertWurstSender(event));
  });

  ipcMain.handle('wurst:piglet:url', async (event, id) => {
    const context = assertWurstSender(event);
    const child = pigletChild(context, id);
    return `wurst://piglet/${encodeURIComponent(child.id)}.wurst`;
  });
}
