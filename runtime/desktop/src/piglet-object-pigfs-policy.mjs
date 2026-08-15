import { pigFsRealmCapabilities, pigFsRealmGovernance } from '@wurster/format';

export function pigletActorId(actor) { return actor?.publicRecord?.identityId ?? null; }

export function pigletRealmGovernance(template = {}) {
  const value = String(template?.governance ?? '').trim().toLowerCase();
  if (!value) return 'ordinary';
  if (!['personal', 'shared'].includes(value)) throw new Error(`Unsupported PigFS realm governance: ${value}`);
  return value;
}

export function pigletRealmTemplates(manifest, actor) {
  const templates = Array.isArray(manifest?.pigfs?.realms) ? manifest.pigfs.realms : [];
  if (!templates.length) throw new Error('This Wurst declares no initial PigFS realm templates');
  const id = pigletActorId(actor);
  return templates.map((template) => {
    const governance = pigletRealmGovernance(template);
    const common = {
      id: template.id,
      label: template.label ?? template.id,
      mount: template.mount ?? `/${template.id}`,
      ...(template.quotaBytes == null ? {} : { quotaBytes: template.quotaBytes })
    };
    if (governance === 'ordinary') return common;
    if (governance === 'personal') return { ...common, governance: 'personal' };
    if (!id) {
      const error = new Error(`Shared PigFS realm ${template.id} requires an authenticated Wurster Identity`);
      error.code = 'WURST_AUTH_REQUIRED';
      throw error;
    }
    const protection = String(template.protection ?? 'public');
    const read = String(template.read ?? (protection === 'sealed' ? 'owner' : 'public'));
    const write = String(template.write ?? 'owner');
    return {
      ...common,
      governance: 'shared',
      audit: String(template.audit ?? 'none'),
      protection,
      access: {
        read: read === 'public' ? { mode: 'public' } : { mode: 'members', identities: [id] },
        write: write === 'authenticated' ? { mode: 'authenticated' } : { mode: 'members', identities: [id] },
        admins: [id]
      }
    };
  });
}

export function pigletRealmSummary(store, manifest, actor) {
  const id = pigletActorId(actor);
  if (!store.root) return (manifest?.pigfs?.realms ?? []).map((realm) => ({
    id: realm.id,
    label: realm.label ?? realm.id,
    mount: realm.mount ?? `/${realm.id}`,
    governance: pigletRealmGovernance(realm),
    protection: realm.protection ?? (pigletRealmGovernance(realm) === 'personal' ? 'sealed' : 'public'),
    initialized: false,
    capabilities: { read: false, write: false, admin: false }
  }));
  return Object.values(store.root.realms ?? {}).map((realm) => ({
    id: realm.id,
    label: realm.label ?? realm.id,
    mount: realm.mount ?? `/${realm.id}`,
    governance: pigFsRealmGovernance(realm),
    protection: realm.protection,
    initialized: true,
    locked: realm.protection === 'sealed' && !store.realmKeys.has(realm.id),
    capabilities: pigFsRealmCapabilities(realm, id, { signedIdentity: Boolean(id) })
  })).sort((a, b) => a.id.localeCompare(b.id));
}
