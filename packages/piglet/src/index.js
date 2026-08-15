const PIGFS_READ = new Set([
  'pigfs.capabilities', 'pigfs.realms', 'pigfs.usage', 'pigfs.stat', 'pigfs.list', 'pigfs.read'
]);
const PIGFS_WRITE = new Set([
  'pigfs.write', 'pigfs.beginWrite', 'pigfs.writeChunk', 'pigfs.commitWrite', 'pigfs.abortWrite',
  'pigfs.remove', 'pigfs.mkdir', 'pigfs.rename'
]);
const PIGLETS_READ = new Set(['piglet.children', 'piglet.inspect']);
const PIGLETS_MANAGE = new Set(['piglet.install', 'piglet.remove']);
const PIGLINK = new Set(['piglink.describe', 'piglink.invoke']);

function mode(value, allowed, label) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (!allowed.includes(raw)) throw new TypeError(`${label} must be ${allowed.map((v) => `"${v}"`).join(' or ')}`);
  return raw;
}

function accessRank(value, modes) {
  const index = modes.indexOf(value);
  return index < 0 ? -1 : index;
}

function assertAvailable(requested, available, modes, label) {
  if (!requested || available === undefined) return;
  if (!available) throw new Error(`${label} is unavailable in the parent Wurst`);
  if (accessRank(requested, modes) > accessRank(available, modes)) throw new Error(`${label} cannot delegate ${requested}; parent only has ${available}`);
}

export function normalizePigletRelationship(input = {}, { parentPigLink = false, parentPigFs = undefined, parentPiglets = undefined } = {}) {
  const isolated = input?.isolated === true;
  const pigfs = mode(input?.pigfs, ['read', 'read-write'], 'parent PigFS access');
  const piglets = mode(input?.piglets, ['read', 'manage'], 'parent Piglet access');
  if (isolated && (pigfs || piglets)) throw new TypeError('An isolated Piglet cannot receive parent PigFS or Piglet-management delegation');
  assertAvailable(pigfs, parentPigFs, ['read', 'read-write'], 'Parent PigFS');
  assertAvailable(piglets, parentPiglets, ['read', 'manage'], 'Parent Piglet service');
  const parent = {
    format: 'wurst/piglet-relationship-1',
    isolated,
    piglink: !isolated && parentPigLink ? { access: 'connect' } : null,
    pigfs: pigfs ? { access: pigfs } : null,
    piglets: piglets ? { access: piglets } : null
  };
  return Object.freeze({
    ...parent,
    piglink: parent.piglink ? Object.freeze(parent.piglink) : null,
    pigfs: parent.pigfs ? Object.freeze(parent.pigfs) : null,
    piglets: parent.piglets ? Object.freeze(parent.piglets) : null
  });
}

export function assertPigletParentMethod(parent, rawMethod) {
  const method = String(rawMethod ?? '');
  if (PIGLINK.has(method)) {
    if (!parent?.piglink) throw new Error('Parent PigLink is unavailable to this Piglet');
    return { service: 'piglink', access: parent.piglink.access, method };
  }
  if (PIGFS_READ.has(method)) {
    if (!parent?.pigfs) throw new Error('Parent PigFS access was not delegated to this Piglet');
    return { service: 'pigfs', access: parent.pigfs.access, method };
  }
  if (PIGFS_WRITE.has(method)) {
    if (!parent?.pigfs) throw new Error('Parent PigFS access was not delegated to this Piglet');
    if (parent.pigfs.access !== 'read-write') throw new Error('Parent PigFS grant is read-only');
    return { service: 'pigfs', access: parent.pigfs.access, method };
  }
  if (PIGLETS_READ.has(method)) {
    if (!parent?.piglets) throw new Error('Parent Piglet registry access was not delegated to this Piglet');
    return { service: 'piglets', access: parent.piglets.access, method };
  }
  if (PIGLETS_MANAGE.has(method)) {
    if (!parent?.piglets) throw new Error('Parent Piglet registry access was not delegated to this Piglet');
    if (parent.piglets.access !== 'manage') throw new Error('Parent Piglet registry grant is read-only');
    return { service: 'piglets', access: parent.piglets.access, method };
  }
  throw new Error(`Unsupported delegated parent operation: ${method}`);
}

function activeCapability(manifest, name) {
  const value = manifest?.capabilities?.[name];
  return value !== false && value != null;
}

export function analyzePigletAuthorityComposition(parent, childManifest = {}) {
  const reasons = [];
  const parentDataReadable = Boolean(parent?.pigfs);
  const parentDataWritable = parent?.pigfs?.access === 'read-write';
  const parentManagement = parent?.piglets?.access === 'manage';
  const network = Array.isArray(childManifest?.capabilities?.network) ? childManifest.capabilities.network : [];

  if (parentDataReadable && network.length) reasons.push({
    code: 'parent-pigfs-to-network',
    level: 'notice',
    detail: `Child can read Parent PigFS and can connect to ${network.length} declared network origin(s).`
  });
  if (parentManagement && network.length) reasons.push({
    code: 'network-to-parent-piglet-management',
    level: 'notice',
    detail: 'Child can use declared network access together with Parent Piglet management.'
  });
  if (parentDataReadable && (activeCapability(childManifest, 'files.save') || activeCapability(childManifest, 'clipboard.write') || activeCapability(childManifest, 'shell.openExternal'))) reasons.push({
    code: 'parent-data-to-host-bridge',
    level: 'notice',
    detail: 'Child can read Parent PigFS and also has a user-mediated host egress capability.'
  });
  if (parentDataWritable && (activeCapability(childManifest, 'files.open') || activeCapability(childManifest, 'camera') || activeCapability(childManifest, 'microphone'))) reasons.push({
    code: 'host-input-to-parent-data',
    level: 'notice',
    detail: 'Child can write Parent PigFS and also has a user-mediated host input capability.'
  });

  return Object.freeze({
    format: 'wurst/authority-composition-1',
    level: reasons.length ? 'notice' : 'internal',
    scope: reasons.length ? 'host-adjacent' : 'wurst-internal',
    hostBoundaryRelevant: reasons.length > 0,
    hostSecretsDelegated: false,
    requiresAdditionalGrant: false,
    reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason)))
  });
}

export { WurstSessionRegistry } from './session.js';
