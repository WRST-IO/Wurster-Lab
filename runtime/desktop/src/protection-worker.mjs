import { ProtectionCore } from './protection-core.mjs';

const core = new ProtectionCore();

process.parentPort.on('message', async (event) => {
  const message = event.data;
  const id = message?.id;
  if (!id) return;
  try {
    const result = await core.dispatch(message.type, message.payload);
    process.parentPort.postMessage({ id, ok: true, result });
    if (message.type === 'shutdown') setImmediate(() => process.exit(0));
  } catch (error) {
    process.parentPort.postMessage({ id, ok: false, error: error?.message ?? String(error) });
  }
});
