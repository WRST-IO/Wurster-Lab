import { openWurstRangeSource, PigFsStore } from '@wurster/format';

function bytesSource(initial) {
  let backing = Buffer.from(initial);
  const source = {
    size: backing.length,
    async read(offset, length) {
      const start = Number(offset), count = Number(length);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > backing.length) throw new Error('Invalid machine PigFS range');
      return Buffer.from(backing.subarray(start, start + count));
    }
  };
  return {
    source,
    append(chunk) {
      backing = Buffer.concat([backing, Buffer.from(chunk)]);
      source.size = backing.length;
    },
    bytes: () => Buffer.from(backing)
  };
}

export async function createPigletMachineServices(world, { invokeParent = null } = {}) {
  const original = await world.source.read(0, world.source.size);
  const memory = bytesSource(original);
  const reader = await openWurstRangeSource(memory.source);
  let store = null;
  let initializedInMemory = false;
  let dirty = false;

  try {
    const policy = reader.manifest?.pigfs;
    if (policy?.format === 'wurst/pigfs-policy-1') {
      store = new PigFsStore({
        source: memory.source,
        baseOffset: reader.baseLength,
        append: async (chunk) => memory.append(chunk),
        sync: async () => {}
      });
      await store.init();
      if (!store.root && policy.writable === true) {
        await store.initialize({ realms: policy.realms ?? [] });
        initializedInMemory = true;
      }
    }

    const serviceManifest = {
      pigfs: Boolean(store),
      parent: world.parent ? {
        piglink: Boolean(world.parent.piglink),
        pigfs: Boolean(world.parent.pigfs),
        piglets: Boolean(world.parent.piglets)
      } : null
    };

    async function ownPigFs(method, args) {
      if (!store) throw new Error('This Wurst does not expose PigFS');
      if (method === 'pigfs.realms') return store.realms();
      if (method === 'pigfs.capabilities') return store.realms().map((realm) => ({ id: realm.id, mount: realm.mount, protection: realm.protection, governance: realm.governance ?? null }));
      if (method === 'pigfs.usage') {
        const requested = args[0] == null ? null : String(args[0]);
        const realms = store.realms().filter((realm) => requested == null || realm.id === requested);
        return realms.map((realm) => ({ id: realm.id, mount: realm.mount, usedBytes: Number(realm.stats?.liveBytes ?? 0), quotaBytes: realm.quotaBytes ?? null }));
      }
      if (method === 'pigfs.stat') return store.stat(args[0]);
      if (method === 'pigfs.list') return store.list(args[0] ?? '/');
      if (method === 'pigfs.read') return store.read(args[0], args[1] ?? {});
      if (method === 'pigfs.write') {
        if (reader.manifest?.pigfs?.writable !== true) throw new Error('This Wurst PigFS is read-only');
        const id = store.beginWrite(args[0], args[2] ?? {});
        try { await store.writeChunk(id, Buffer.from(args[1] ?? [])); const result = await store.commitWrite(id); dirty = true; return result; }
        catch (error) { store.abortWrite(id); throw error; }
      }
      if (method === 'pigfs.mkdir') { if (reader.manifest?.pigfs?.writable !== true) throw new Error('This Wurst PigFS is read-only'); const result = await store.mkdir(args[0], args[1] ?? {}); dirty = true; return result; }
      if (method === 'pigfs.remove') { if (reader.manifest?.pigfs?.writable !== true) throw new Error('This Wurst PigFS is read-only'); const result = await store.remove(args[0], args[1] ?? {}); dirty = true; return result; }
      if (method === 'pigfs.rename') { if (reader.manifest?.pigfs?.writable !== true) throw new Error('This Wurst PigFS is read-only'); const result = await store.rename(args[0], args[1], args[2] ?? {}); dirty = true; return result; }
      throw new Error(`Unsupported machine PigFS operation: ${method}`);
    }

    async function services(method, args = []) {
      const name = String(method ?? '');
      if (name.startsWith('pigfs.')) return ownPigFs(name, args);
      if (name.startsWith('parent.')) {
        if (typeof invokeParent !== 'function') throw new Error('Parent Wurst services are unavailable');
        const delegated = name.slice('parent.'.length).replace(/^piglets\./, 'piglet.');
        return invokeParent(delegated, args);
      }
      throw new Error(`Unsupported machine runtime service: ${name}`);
    }

    return {
      serviceManifest,
      services,
      changed: () => dirty,
      bytes: () => memory.bytes(),
      initializedInMemory: () => initializedInMemory,
      close: async () => { store?.close(); await reader.close(); }
    };
  } catch (error) {
    store?.close();
    await reader.close().catch(() => {});
    throw error;
  }
}
