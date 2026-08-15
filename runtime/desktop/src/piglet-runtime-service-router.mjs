import { invokeRootBackedWurstService } from './piglet-object-runtime.mjs';
import { unlockDesktopPigletApplication } from './piglet-route-runtime.mjs';

export function createPigletRuntimeServiceRouter({
  registry,
  contextScope,
  requireAttachment,
  actorFor,
  nestedChildren,
  resolveNested,
  openDescendant,
  invalidateWorld,
  onSessionChanged,
  sessionMetadata,
  read,
  persist,
  refresh,
  invoke,
  close,
  machineDescribe,
  machineInvoke
}) {
  async function runtimeInvoke(parentContext, rawHandle, method, args = []) {
    const handle = String(rawHandle ?? '');
    const { world } = requireAttachment(parentContext, handle);
    const name = String(method ?? '');
    const safeArgs = Array.isArray(args) ? args : [];
    if (name === 'application.unlock') return unlockDesktopPigletApplication(world, safeArgs[0]);
    if (!world.runtimeSource.rootBacked) throw new Error('Desktop runtime services require Root-backed Wurst object storage');

    if (name.startsWith('pigfs.')) {
      const outcome = await invokeRootBackedWurstService(world, name, safeArgs, { actor: actorFor(parentContext) });
      if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'committed')) {
        if (outcome.committed) {
          await world.source.refresh?.();
          await invalidateWorld(world);
          const session = registry.bump(handle, { metadata: sessionMetadata(world.descriptor, world.source) });
          if (typeof onSessionChanged === 'function') {
            try { onSessionChanged(parentContext, { session, writer: handle, size: world.source.size }); } catch {}
          }
        }
        return outcome.result;
      }
      return outcome;
    }
    if (name === 'piglet.children') return nestedChildren(parentContext, world);
    if (name === 'piglet.running') return registry.list(contextScope(parentContext));
    if (name === 'piglet.inspect') return (await resolveNested(parentContext, world, safeArgs[0])).descriptor;
    if (name === 'piglet.embedOpen' || name === 'piglet.machineConnect') {
      const { descriptor, source } = await resolveNested(parentContext, world, safeArgs[0]);
      const options = { ...(safeArgs[1] || {}), ...(name === 'piglet.machineConnect' ? { kind: 'machine' } : {}) };
      if (options.kind === 'machine' && !descriptor.piglink?.headless) throw new Error('This Wurst does not declare a headless PigLink end');
      return openDescendant(parentContext, world, descriptor, source, options);
    }
    if (name === 'piglet.embedRead') return read(parentContext, safeArgs[0], safeArgs[1], safeArgs[2]);
    if (name === 'piglet.embedPersist') return persist(parentContext, safeArgs[0], safeArgs[1]);
    if (name === 'piglet.embedRefresh') return refresh(parentContext, safeArgs[0]);
    if (name === 'piglet.embedInvoke') return invoke(parentContext, safeArgs[0], safeArgs[1], safeArgs[2] || []);
    if (name === 'piglet.embedClose' || name === 'piglet.machineClose') return close(parentContext, safeArgs[0]);
    if (name === 'piglet.machineDescribe') return machineDescribe(parentContext, safeArgs[0]);
    if (name === 'piglet.machineInvoke') return machineInvoke(parentContext, safeArgs[0], safeArgs[1], safeArgs[2] || {}, safeArgs[3] || {});
    if (name === 'piglet.install' || name === 'piglet.remove') throw new Error('Nested Piglet install/remove is not exposed until the parent grants explicit relationship mutation authority');
    throw new Error(`Unsupported Desktop Wurst object service: ${name}`);
  }

  return Object.freeze({ runtimeInvoke });
}
