import { closeDesktopPigletRoute, serveDesktopPigletRoute } from './piglet-route-runtime.mjs';
import { closeRootBackedWurstService } from './piglet-object-runtime.mjs';

export function createPigletWorldRuntime({ registry, worlds, contextScope }) {
  async function invalidate(world) {
    await world?.packageReader?.close?.().catch(() => {});
    if (world) { world.packageReader = null; world.packageReaderSize = null; }
    await closeDesktopPigletRoute(world);
  }

  async function dispose(world) {
    await invalidate(world);
    await closeRootBackedWurstService(world);
  }

  function worldBySession(rawSessionId) { return worlds.get(String(rawSessionId ?? '')) ?? null; }

  async function serveVirtualRoute(rawSessionId, request = {}) {
    const sessionId = String(rawSessionId ?? '');
    return serveDesktopPigletRoute(worldBySession(sessionId), { ...request, sessionId });
  }

  async function closeHandle(parentContext, rawHandle, requireAttachment) {
    const handle = String(rawHandle ?? '');
    requireAttachment(parentContext, handle);
    const released = registry.release(handle);
    if (released.closed) {
      const world = worlds.get(released.session.id);
      await dispose(world);
      worlds.delete(released.session.id);
    }
    return true;
  }

  async function closeContext(parentContext) {
    const scope = contextScope(parentContext);
    const sessionIds = registry.list(scope).map((item) => item.id);
    registry.releaseScope(scope);
    for (const id of sessionIds) {
      await dispose(worlds.get(id));
      worlds.delete(id);
    }
  }

  return Object.freeze({ invalidate, worldBySession, serveVirtualRoute, closeHandle, closeContext });
}
