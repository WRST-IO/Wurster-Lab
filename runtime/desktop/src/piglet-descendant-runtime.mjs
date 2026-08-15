import { openWurstRangeSource } from '@wurster/format';
import { analyzePigletAuthorityComposition, normalizePigletRelationship } from '@wurster/piglet';
import { inspectPigletSource } from './piglet-package.mjs';
import { invokeRootBackedWurstService } from './piglet-object-runtime.mjs';

export function createPigletDescendantRuntime({
  registry,
  worlds,
  storage,
  activeActor,
  contextScope,
  descriptorLocator,
  sessionMetadata,
  publicDescriptor
}) {
  function actorFor(context) { return typeof activeActor === 'function' ? activeActor(context) : null; }

  async function packageReader(world) {
    if (world.packageReader && world.packageReaderSize === world.source.size) return world.packageReader;
    await world.packageReader?.close?.().catch(() => {});
    world.packageReader = await openWurstRangeSource(world.source);
    world.packageReaderSize = world.source.size;
    return world.packageReader;
  }

  async function nestedRelationship(parentWorld, descriptor, options = {}) {
    const reader = await packageReader(parentWorld);
    const manifest = reader.manifest ?? {};
    const relationship = normalizePigletRelationship(options.parent ?? {}, {
      parentPigLink: Boolean(manifest.piglink),
      parentPigFs: manifest.pigfs ? (manifest.pigfs.writable === true ? 'read-write' : 'read') : null,
      parentPiglets: manifest.pigfs?.writable === true ? 'manage' : 'read'
    });
    const parent = Object.freeze({
      ...relationship,
      application: Object.freeze({ id: manifest.id ?? null, name: manifest.name ?? null, version: manifest.version ?? null })
    });
    return { parent, composition: analyzePigletAuthorityComposition(parent, { capabilities: descriptor.capabilities ?? {} }) };
  }

  async function nestedPigFsSource(parentContext, parentWorld, path) {
    const stat = await invokeRootBackedWurstService(parentWorld, 'pigfs.stat', [path], { actor: actorFor(parentContext) });
    if (!stat || stat.type !== 'file') throw new Error(`Embedded PigFS Wurst not found: ${path}`);
    return {
      size: Number(stat.size),
      storageObjectId: stat.objectId ?? null,
      async read(offset, length) {
        const start = Number(offset), wanted = Number(length);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(wanted) || start < 0 || wanted < 0 || start + wanted > Number(stat.size)) throw new Error('Invalid nested PigFS Wurst range');
        const parts = [];
        for (let cursor = 0; cursor < wanted; cursor += 2 * 1024 * 1024) {
          const slice = Math.min(2 * 1024 * 1024, wanted - cursor);
          const result = await invokeRootBackedWurstService(parentWorld, 'pigfs.read', [path, { offset: start + cursor, length: slice }], { actor: actorFor(parentContext) });
          const data = Buffer.from(result?.data ?? []);
          if (data.length !== slice) throw new Error(`Embedded PigFS Wurst range is unavailable: ${path}`);
          parts.push(data);
        }
        return Buffer.concat(parts, wanted);
      }
    };
  }

  async function resolveNested(parentContext, parentWorld, rawRef) {
    const ref = String(rawRef ?? '').trim();
    if (!ref) throw new Error('Embedded Wurst source is required');
    const reader = await packageReader(parentWorld);
    if (ref.startsWith('wurst://pigfs/')) {
      const parsed = new URL(ref);
      return resolveNested(parentContext, parentWorld, `pigfs:/${decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))}`);
    }
    if (ref.startsWith('pigfs:') || ref.startsWith('/')) {
      const path = ref.startsWith('pigfs:') ? ref.slice('pigfs:'.length) : ref;
      const normalized = path.startsWith('/') ? path : `/${path}`;
      const source = await nestedPigFsSource(parentContext, parentWorld, normalized);
      const descriptor = await inspectPigletSource(source, { ref: `pigfs:${normalized}`, id: normalized, label: null, source: 'pigfs', path: normalized, storageObjectId: source.storageObjectId ?? null, mutable: true });
      descriptor.label = descriptor.application?.name ?? normalized.split('/').at(-1);
      return { descriptor, source };
    }
    if (ref.startsWith('wurst://app/')) {
      const parsed = new URL(ref);
      const logical = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      const entry = reader.entry(logical);
      if (!entry || (entry.scope ?? 'app') !== 'app' || entry.encryption) throw new Error(`Embedded Wurst resource is unavailable: ${logical}`);
      const source = { size: entry.length, async read(offset, length) { const loaded = await reader.readRange(logical, offset, length, { verify: true }); return Buffer.from(loaded?.data ?? []); } };
      const descriptor = await inspectPigletSource(source, { ref, id: logical, label: null, source: 'resource', path: logical, mutable: false, sha256: entry.sha256 ?? null });
      descriptor.label = descriptor.application?.name ?? logical.split('/').at(-1);
      return { descriptor, source };
    }
    const id = ref.startsWith('builtin:') ? ref.slice('builtin:'.length) : ref;
    const child = structuredClone(reader.manifest?.piglet?.children ?? []).find((item) => item.id === id);
    if (!child) throw new Error(`Unknown Piglet child: ${id}`);
    const entry = reader.entry(child.entry);
    if (!entry || entry.scope !== 'piglet' || entry.encryption) throw new Error(`Piglet child is unavailable: ${id}`);
    const source = { size: entry.length, async read(offset, length) { const loaded = await reader.readRange(child.entry, offset, length, { verify: true }); return Buffer.from(loaded?.data ?? []); } };
    const inspected = await inspectPigletSource(source, { ...child, ref: `builtin:${id}`, source: 'builtin', mutable: false, sha256: child.sha256 ?? null });
    return { descriptor: { ...child, ...inspected }, source };
  }

  async function openDescendant(parentContext, parentWorld, descriptor, source, options = {}) {
    if (!parentWorld.runtimeSource?.objectId) throw new Error('Nested persistent Wurst requires a parent Wurst Object ID');
    const { parent, composition } = await nestedRelationship(parentWorld, descriptor, options);
    const locator = `${parentWorld.runtimeSource.objectId}\u0000${descriptorLocator(descriptor)}`;
    const attached = registry.attach(contextScope(parentContext), locator, {
      kind: options.kind === 'machine' ? 'machine' : 'view', relationship: parent, metadata: sessionMetadata(descriptor, source)
    });
    let world = worlds.get(attached.session.id);
    try {
      if (attached.created) {
        const runtimeSource = await storage.prepareRuntimeSource(parentContext, descriptor, source, { parentObjectId: parentWorld.runtimeSource.objectId });
        const runtimeDescriptor = runtimeSource.objectId ? { ...descriptor, objectId: runtimeSource.objectId } : descriptor;
        world = { parentContext, logicalParentWorld: parentWorld, descriptor: runtimeDescriptor, runtimeSource, source: runtimeSource.source, parent, composition };
        worlds.set(attached.session.id, world);
      }
      if (!world) throw new Error('Nested Wurst session source is unavailable');
      return {
        handle: attached.attachment.id,
        size: world.source.size,
        descriptor: publicDescriptor(world.descriptor),
        writable: Boolean((world.runtimeSource.rootBacked || world.runtimeSource.path) && world.descriptor.data?.writable),
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

  async function nestedChildren(parentContext, parentWorld) {
    const reader = await packageReader(parentWorld);
    const out = [];
    for (const child of reader.manifest?.piglet?.children ?? []) {
      try { out.push((await resolveNested(parentContext, parentWorld, `builtin:${child.id}`)).descriptor); }
      catch { out.push({ ...structuredClone(child), ref: `builtin:${child.id}`, source: 'builtin', mutable: false }); }
    }
    return out;
  }

  return Object.freeze({ actorFor, packageReader, resolveNested, openDescendant, nestedChildren });
}
