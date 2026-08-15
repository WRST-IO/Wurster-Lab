import { validateJsonValue } from '@wurster/piglink';

export async function loadPigLinkEntry(context, rawPath) {
  const declaration = context.manifest.piglink;
  if (!declaration?.entry) return null;
  const requested = String(rawPath ?? '');
  if (requested !== 'entry.js') return null;
  const entry = context.reader.entry(declaration.entry);
  if (!entry || entry.scope !== 'piglink' || entry.encryption) return null;
  const loaded = await context.reader.read(declaration.entry, { verify: true });
  return loaded?.data ?? null;
}

export function createDesktopPigLinkRuntime({
  ipcMain,
  assertWurstSender,
  getWebContents
}) {
  let nextRequestId = 1;
  const pendingInvocations = new Map();

  async function invoke(context, rawName, payload = {}) {
    const declaration = context.manifest.piglink;
    const name = String(rawName ?? '');
    const spec = declaration?.actions?.[name];
    if (!spec) throw new Error(`Unknown Wurst action: ${name}`);
    validateJsonValue(payload, spec.input, '$input');

    const webContents = getWebContents(context);
    if (!webContents || webContents.isDestroyed?.()) throw new Error('Wurst renderer is not available');

    const requestId = `pl-${nextRequestId++}`;
    const timeoutMs = Math.min(Number(spec.timeoutMs ?? 5000), 60000);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingInvocations.delete(requestId);
        reject(new Error(`Wurst action exceeded ${timeoutMs} ms: ${name}`));
      }, timeoutMs);
      pendingInvocations.set(requestId, { context, name, spec, resolve, reject, timer });
      webContents.send('wurst:piglink:invoke-request', { requestId, name, input: payload });
    });
  }

  function closeContext(context) {
    for (const [requestId, pending] of pendingInvocations) {
      if (pending.context !== context) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('Wurst closed before action completed'));
      pendingInvocations.delete(requestId);
    }
  }

  ipcMain.handle('wurst:piglink:describe', async (event) => {
    return assertWurstSender(event).manifest.piglink ?? null;
  });

  ipcMain.handle('wurst:piglink:invoke', async (event, name, payload = {}) => {
    return invoke(assertWurstSender(event), name, payload);
  });

  ipcMain.on('wurst:piglink:invoke-result', (event, message = {}) => {
    const context = assertWurstSender(event);
    const requestId = String(message.requestId ?? '');
    const pending = pendingInvocations.get(requestId);
    if (!pending || pending.context !== context) return;
    pendingInvocations.delete(requestId);
    clearTimeout(pending.timer);
    if (!message.ok) {
      pending.reject(new Error(String(message.error ?? `Wurst action failed: ${pending.name}`)));
      return;
    }
    try {
      const result = message.result == null ? null : structuredClone(message.result);
      if (pending.spec.output) validateJsonValue(result, pending.spec.output, '$output');
      pending.resolve(result);
    } catch (error) {
      pending.reject(error);
    }
  });

  ipcMain.on('wurst:piglink:event', (event, rawName, payload) => {
    const context = assertWurstSender(event);
    const name = String(rawName ?? '');
    const spec = context.manifest.piglink?.events?.[name];
    if (!spec) return;
    try {
      if (spec.payload) validateJsonValue(payload, spec.payload, '$event');
      const clean = structuredClone(payload ?? null);
      context.lastPigLinkEvent = { name, payload: clean, at: Date.now() };
      const webContents = getWebContents(context);
      if (webContents && !webContents.isDestroyed?.()) webContents.send('wurst:piglink:event-accepted', { name, payload: clean });
    } catch {
      // Invalid events never cross the runtime boundary.
    }
  });

  return { invoke, closeContext };
}
