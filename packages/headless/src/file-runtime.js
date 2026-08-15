import { openLocalPigFsStore, openWurstFile, openWurstRangeSource } from '@wurster/format';
import { WurstSessionRegistry } from '@wurster/piglet';

function normalizeRef(raw) {
  const ref = String(raw ?? '').trim();
  if (!ref) throw new Error('Piglet reference is required');
  return ref;
}

function publicChildDescriptor(reader, ref, sourceKind, path = null, objectId = null) {
  return {
    ref,
    source: sourceKind,
    path,
    objectId,
    application: {
      id: reader.manifest?.id ?? null,
      name: reader.manifest?.name ?? null,
      version: reader.manifest?.version ?? null
    },
    piglink: reader.manifest?.piglink ? {
      format: reader.manifest.piglink.format ?? null,
      headless: reader.manifest.piglink.headless === true,
      actions: Object.keys(reader.manifest.piglink.actions ?? {}),
      events: Object.keys(reader.manifest.piglink.events ?? {})
    } : null,
    pigfs: reader.manifest?.pigfs ? {
      format: reader.manifest.pigfs.format ?? null,
      writable: reader.manifest.pigfs.writable === true
    } : null
  };
}

export async function createHeadlessFileRuntime(filePath, { invokeSourceAction, describeSource } = {}) {
  if (typeof invokeSourceAction !== 'function' || typeof describeSource !== 'function') throw new Error('Headless file runtime requires source PigLink helpers');
  const reader = await openWurstFile(filePath);
  const registry = new WurstSessionRegistry();
  const connections = new Map();
  let store = null;

  async function ensureStore() {
    if (store) return store;
    if (reader.manifest?.pigfs?.format !== 'wurst/pigfs-policy-1' || reader.manifest.pigfs.writable !== true) throw new Error('This Wurst does not declare writable PigFS');
    if (reader.carrier) throw new Error('Headless writable PigFS is unavailable for carrier Wursts');
    store = await openLocalPigFsStore(filePath, reader);
    if (!store.root) await store.initialize({ realms: reader.manifest.pigfs.realms ?? [] });
    return store;
  }

  async function pigFsStat(path) {
    if (store) return store.stat(path);
    return reader.pigFsStat(path);
  }

  async function pigFsList(path = '/') {
    if (store) return store.list(path);
    return reader.pigFsList(path);
  }

  async function pigFsRead(path, options = {}) {
    if (store) return store.read(path, options);
    const result = await reader.pigFsReadRange(path, Number(options.offset ?? 0), options.length == null ? null : Number(options.length));
    if (!result) throw new Error(`PigFS file not found: ${path}`);
    return result.data;
  }

  async function resolveChild(rawRef) {
    const ref = normalizeRef(rawRef);
    if (ref.startsWith('builtin:')) {
      const id = ref.slice('builtin:'.length);
      const child = (reader.manifest?.piglet?.children ?? []).find((item) => String(item.id) === id);
      if (!child) throw new Error(`Unknown Piglet child: ${id}`);
      const entry = reader.entry(child.entry);
      if (!entry || entry.scope !== 'piglet' || entry.encryption) throw new Error(`Piglet child is unavailable: ${id}`);
      const source = {
        size: entry.length,
        async read(offset, length) {
          const loaded = await reader.readRange(child.entry, offset, length, { verify: true });
          if (!loaded || loaded.data.length !== length) throw new Error(`Piglet child range is unavailable: ${id}`);
          return loaded.data;
        }
      };
      const childReader = await openWurstRangeSource(source);
      try { return { source, locator: `builtin:${id}`, descriptor: publicChildDescriptor(childReader, `builtin:${id}`, 'builtin') }; }
      finally { await childReader.close(); }
    }
    const path = ref.startsWith('pigfs:') ? ref.slice('pigfs:'.length) : ref.startsWith('/') ? ref : null;
    if (!path) throw new Error('Headless Piglet references must use builtin:<id>, pigfs:/path or /path');
    const stat = await pigFsStat(path);
    if (!stat || stat.type !== 'file') throw new Error(`PigFS Wurst not found: ${path}`);
    const source = {
      size: stat.size,
      async read(offset, length) {
        const data = await pigFsRead(path, { offset, length });
        if (data.length !== length) throw new Error(`PigFS child range is unavailable: ${path}`);
        return data;
      }
    };
    const childReader = await openWurstRangeSource(source);
    try {
      return {
        source,
        locator: stat.objectId ? `pigfs://object/${stat.objectId}` : `pigfs:${path}`,
        descriptor: publicChildDescriptor(childReader, `pigfs:${path}`, 'pigfs', path, stat.objectId ?? null)
      };
    } finally { await childReader.close(); }
  }

  async function machineConnect(ref, options = {}) {
    if (options?.parent?.pigfs || options?.parent?.piglets) throw new Error('Headless nested Parent-service delegation is not implemented yet');
    const child = await resolveChild(ref);
    if (!child.descriptor.piglink?.headless) throw new Error('This Wurst does not declare a headless PigLink end');
    const attached = registry.attach(String(reader.manifest?.id ?? filePath), child.locator, { kind: 'machine', relationship: null, metadata: child.descriptor.application });
    connections.set(attached.attachment.id, child);
    return { handle: attached.attachment.id, descriptor: child.descriptor, session: attached.session };
  }

  function requireConnection(rawHandle) {
    const handle = String(rawHandle ?? '');
    const child = connections.get(handle);
    if (!child) throw new Error('Unknown headless Piglet machine connection');
    registry.requireAttachment(handle);
    return { handle, child };
  }

  async function machineDescribe(handle) {
    const { child } = requireConnection(handle);
    return describeSource(child.source);
  }

  async function machineInvoke(handle, name, input = {}, options = {}) {
    const { child } = requireConnection(handle);
    registry.refresh(handle);
    const result = await invokeSourceAction(child.source, String(name ?? ''), input ?? {}, options ?? {});
    return { ...result, session: registry.describeByAttachment(handle) };
  }

  function machineClose(rawHandle) {
    const { handle } = requireConnection(rawHandle);
    connections.delete(handle);
    return registry.release(handle).closed;
  }

  async function services(method, args = []) {
    const name = String(method ?? '');
    if (name === 'pigfs.realms') return store ? store.realms() : Object.values(reader.pigFsRoot?.realms ?? {}).map((realm) => structuredClone(realm));
    if (name === 'pigfs.capabilities') return (reader.manifest?.pigfs?.realms ?? []).map((realm) => ({ id: realm.id, mount: realm.mount ?? `/${realm.id}`, writable: reader.manifest?.pigfs?.writable === true }));
    if (name === 'pigfs.usage') return [];
    if (name === 'pigfs.stat') return pigFsStat(args[0]);
    if (name === 'pigfs.list') return pigFsList(args[0] ?? '/');
    if (name === 'pigfs.read') return pigFsRead(args[0], args[1] ?? {});
    if (name === 'pigfs.write') { const fs = await ensureStore(); const id = fs.beginWrite(args[0], args[2] ?? {}); try { await fs.writeChunk(id, Buffer.from(args[1] ?? [])); return await fs.commitWrite(id); } catch (error) { fs.abortWrite(id); throw error; } }
    if (name === 'pigfs.mkdir') return (await ensureStore()).mkdir(args[0], args[1] ?? {});
    if (name === 'pigfs.remove') return (await ensureStore()).remove(args[0], args[1] ?? {});
    if (name === 'pigfs.rename') return (await ensureStore()).rename(args[0], args[1], args[2] ?? {});
    if (name === 'piglet.running') return registry.list(String(reader.manifest?.id ?? filePath));
    if (name === 'piglet.inspect') return (await resolveChild(args[0])).descriptor;
    if (name === 'piglet.machineConnect') return machineConnect(args[0], args[1] ?? {});
    if (name === 'piglet.machineDescribe') return machineDescribe(args[0]);
    if (name === 'piglet.machineInvoke') return machineInvoke(args[0], args[1], args[2] ?? {}, args[3] ?? {});
    if (name === 'piglet.machineClose') return machineClose(args[0]);
    throw new Error(`Unsupported headless Wurst service: ${name}`);
  }

  return {
    serviceManifest: {
      pigfs: reader.manifest?.pigfs?.format === 'wurst/pigfs-policy-1',
      piglet: true,
      parent: null
    },
    services,
    close: async () => {
      for (const handle of [...connections.keys()]) { try { machineClose(handle); } catch {} }
      if (store?.closeFile) await store.closeFile();
      else store?.close();
      await reader.close();
    }
  };
}
