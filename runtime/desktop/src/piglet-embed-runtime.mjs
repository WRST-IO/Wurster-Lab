import { inspectPigletSource } from './piglet-package.mjs';
import { describePigLinkSource, invokePigLinkActionSource } from '@wurster/headless';
import { createPigletMachineServices } from './piglet-machine-runtime.mjs';
import {
  WurstSessionRegistry,
  analyzePigletAuthorityComposition,
  assertPigletParentMethod,
  normalizePigletRelationship
} from '@wurster/piglet';

function publicDescriptor(descriptor) {
  return {
    ref: descriptor.ref,
    source: descriptor.source,
    path: descriptor.path ?? null,
    objectId: descriptor.objectId ?? null,
    application: structuredClone(descriptor.application ?? null),
    signature: structuredClone(descriptor.signature ?? null),
    data: structuredClone(descriptor.data ?? null),
    protection: structuredClone(descriptor.protection ?? null),
    capabilities: structuredClone(descriptor.capabilities ?? {}),
    piglink: structuredClone(descriptor.piglink ?? null)
  };
}

function contextScope(context) {
  return String(context?.runtimeBinding || `wurst:${context?.manifest?.id || 'unknown'}`);
}

function descriptorLocator(descriptor) {
  if (descriptor?.objectId) return `pigfs://object/${descriptor.objectId}`;
  return String(descriptor?.ref || descriptor?.path || descriptor?.application?.id || 'unknown-child');
}

function relationshipFor(parentContext, descriptor, options, relationshipOptions) {
  const availability = typeof relationshipOptions === 'function' ? relationshipOptions(parentContext) : {};
  const relationship = normalizePigletRelationship(options.parent ?? {}, {
    parentPigLink: Boolean(parentContext.manifest?.piglink),
    ...availability
  });
  const parent = Object.freeze({
    ...relationship,
    application: Object.freeze({
      id: parentContext.manifest?.id ?? null,
      name: parentContext.manifest?.name ?? null,
      version: parentContext.manifest?.version ?? null
    })
  });
  return {
    parent,
    composition: analyzePigletAuthorityComposition(parent, { capabilities: descriptor.capabilities ?? {} })
  };
}

function sessionMetadata(descriptor, source) {
  return {
    application: structuredClone(descriptor.application ?? null),
    ref: descriptor.ref ?? null,
    source: descriptor.source ?? null,
    path: descriptor.path ?? null,
    objectId: descriptor.objectId ?? null,
    size: Number(source?.size ?? descriptor.bytes ?? 0)
  };
}

export function createPigletEmbedRuntime({ storage, invokeParent = null, relationshipOptions = null, onSessionChanged = null, onMachineEvent = null }) {
  const registry = new WurstSessionRegistry();
  const worlds = new Map();

  async function open(parentContext, descriptor, source, options = {}) {
    const { parent, composition } = relationshipFor(parentContext, descriptor, options, relationshipOptions);
    const attached = registry.attach(contextScope(parentContext), descriptorLocator(descriptor), {
      kind: options.kind === 'machine' ? 'machine' : 'view',
      relationship: parent,
      metadata: sessionMetadata(descriptor, source)
    });
    let world = worlds.get(attached.session.id);
    try {
      if (attached.created) {
        const runtimeSource = await storage.prepareRuntimeSource(parentContext, descriptor, source);
        world = {
          parentContext,
          descriptor,
          runtimeSource,
          source: runtimeSource.source,
          parent,
          composition
        };
        worlds.set(attached.session.id, world);
      }
      if (!world) throw new Error('Wurst session source is unavailable');
      return {
        handle: attached.attachment.id,
        size: world.source.size,
        descriptor: publicDescriptor(world.descriptor),
        writable: Boolean(world.runtimeSource.path && world.descriptor.data?.writable),
        parent: world.parent,
        composition: world.composition,
        session: registry.describeByAttachment(attached.attachment.id)
      };
    } catch (error) {
      const released = registry.release(attached.attachment.id);
      if (released.closed) worlds.delete(released.session.id);
      throw error;
    }
  }

  function requireAttachment(parentContext, rawHandle) {
    const attachment = registry.requireAttachment(String(rawHandle ?? ''));
    if (attachment.session.scope !== contextScope(parentContext)) throw new Error('Unknown Wurst embed handle');
    const world = worlds.get(attachment.session.id);
    if (!world || world.parentContext !== parentContext) throw new Error('Unknown Wurst embed handle');
    return { attachment, world };
  }

  async function read(parentContext, rawHandle, offset, length) {
    const { world } = requireAttachment(parentContext, rawHandle);
    const start = Number(offset), size = Number(length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > world.source.size) throw new Error('Invalid Wurst embed byte range');
    return world.source.read(start, size);
  }

  async function invoke(parentContext, rawHandle, method, args = []) {
    const { world } = requireAttachment(parentContext, rawHandle);
    if (typeof invokeParent !== 'function') throw new Error('Parent runtime services are unavailable');
    const name = String(method ?? '');
    assertPigletParentMethod(world.parent, name);
    return invokeParent(parentContext, name, Array.isArray(args) ? args : [], world);
  }

  async function persist(parentContext, rawHandle, payload) {
    const handle = String(rawHandle ?? '');
    registry.requireFresh(handle);
    const { world } = requireAttachment(parentContext, handle);
    if (!world.runtimeSource.path || !world.descriptor.data?.writable) throw new Error('This embedded Wurst is not writable');
    const data = payload instanceof Uint8Array ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : Buffer.from(payload ?? []);
    const inspected = await inspectPigletSource({ size: data.length, async read(offset, length) { return data.subarray(offset, offset + length); } });
    if (inspected.signature?.status === 'invalid') throw new Error(`Embedded Wurst signature became invalid: ${inspected.signature.error ?? 'verification failed'}`);
    if (inspected.application?.id !== world.descriptor.application?.id) throw new Error('Embedded Wurst identity changed during persistence');
    await storage.persistRuntimeSource(parentContext, world.runtimeSource, data);
    world.source = await storage.openSource(parentContext, world.runtimeSource.path);
    world.runtimeSource.source = world.source;
    const session = registry.bump(handle, { metadata: sessionMetadata(world.descriptor, world.source) });
    if (typeof onSessionChanged === 'function') {
      try { onSessionChanged(parentContext, { session, writer: handle, size: world.source.size }); } catch {}
    }
    return { ok: true, size: data.length, path: world.runtimeSource.path, revision: session.revision, session };
  }

  function refresh(parentContext, rawHandle) {
    const handle = String(rawHandle ?? '');
    const { world } = requireAttachment(parentContext, handle);
    const refreshed = registry.refresh(handle);
    return { size: world.source.size, session: refreshed.session };
  }

  function list(parentContext) {
    return registry.list(contextScope(parentContext));
  }

  async function machineDescribe(parentContext, rawHandle) {
    const handle = String(rawHandle ?? '');
    const { attachment, world } = requireAttachment(parentContext, handle);
    if (attachment.kind !== 'machine') throw new Error('Wurst session attachment is not a machine client');
    registry.refresh(handle);
    return describePigLinkSource(world.source);
  }

  async function machineInvoke(parentContext, rawHandle, rawName, input = {}, options = {}) {
    const handle = String(rawHandle ?? '');
    const { attachment, world } = requireAttachment(parentContext, handle);
    if (attachment.kind !== 'machine') throw new Error('Wurst session attachment is not a machine client');
    registry.refresh(handle);
    const services = await createPigletMachineServices(world, {
      invokeParent: (method, args) => invoke(parentContext, handle, method, args)
    });
    try {
      const invoked = await invokePigLinkActionSource(world.source, String(rawName ?? ''), input ?? {}, {
        ...(options ?? {}),
        serviceManifest: services.serviceManifest,
        services: services.services
      });
      let session = registry.describeByAttachment(handle);
      if (services.changed()) {
        const persisted = await persist(parentContext, handle, services.bytes());
        session = persisted.session;
      }
      if (typeof onMachineEvent === 'function') {
        for (const event of invoked.events ?? []) {
          try { onMachineEvent(parentContext, { session, writer: handle, name: String(event?.name ?? ''), payload: structuredClone(event?.payload ?? null) }); } catch {}
        }
      }
      return { ...invoked, session };
    } finally {
      await services.close();
    }
  }

  function close(parentContext, rawHandle) {
    const handle = String(rawHandle ?? '');
    requireAttachment(parentContext, handle);
    const released = registry.release(handle);
    if (released.closed) worlds.delete(released.session.id);
    return true;
  }

  function closeContext(parentContext) {
    const scope = contextScope(parentContext);
    const sessionIds = registry.list(scope).map((item) => item.id);
    registry.releaseScope(scope);
    for (const id of sessionIds) worlds.delete(id);
  }

  return { open, read, invoke, persist, refresh, list, machineDescribe, machineInvoke, close, closeContext };
}
