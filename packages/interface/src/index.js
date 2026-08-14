export const PIGLINK_FORMAT = 'wurst/piglink-1';
export const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
export const MAX_ACTION_TIMEOUT_MS = 60_000;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertName(value, label) {
  const name = String(value ?? '');
  if (!NAME_RE.test(name)) throw new Error(`${label} must match ${NAME_RE}`);
  return name;
}

function cloneJson(value, label = 'value') {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

export function validateJsonSchema(schema, label = 'schema') {
  if (schema == null) return null;
  if (!plainObject(schema)) throw new Error(`${label} must be an object`);
  const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  if (schema.type != null && !allowedTypes.has(schema.type)) throw new Error(`${label}.type is not supported`);
  if (schema.properties != null) {
    if (!plainObject(schema.properties)) throw new Error(`${label}.properties must be an object`);
    for (const [key, child] of Object.entries(schema.properties)) validateJsonSchema(child, `${label}.properties.${key}`);
  }
  if (schema.items != null) validateJsonSchema(schema.items, `${label}.items`);
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some((v) => typeof v !== 'string'))) {
    throw new Error(`${label}.required must be an array of strings`);
  }
  if (schema.enum != null && !Array.isArray(schema.enum)) throw new Error(`${label}.enum must be an array`);
  return cloneJson(schema, label);
}

function normalizeAction(name, raw = {}) {
  if (!plainObject(raw)) throw new Error(`piglink.actions.${name} must be an object`);
  const timeoutMs = raw.timeoutMs == null ? DEFAULT_ACTION_TIMEOUT_MS : Number(raw.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_ACTION_TIMEOUT_MS) {
    throw new Error(`piglink.actions.${name}.timeoutMs must be between 1 and ${MAX_ACTION_TIMEOUT_MS}`);
  }
  return {
    description: String(raw.description ?? '').trim(),
    readOnly: raw.readOnly === true,
    input: validateJsonSchema(raw.input ?? { type: 'object' }, `piglink.actions.${name}.input`),
    output: validateJsonSchema(raw.output ?? null, `piglink.actions.${name}.output`),
    timeoutMs
  };
}

function normalizeEvent(name, raw = {}) {
  if (!plainObject(raw)) throw new Error(`piglink.events.${name} must be an object`);
  return {
    description: String(raw.description ?? '').trim(),
    payload: validateJsonSchema(raw.payload ?? null, `piglink.events.${name}.payload`)
  };
}

function normalizeTest(raw, index, actions) {
  if (!plainObject(raw)) throw new Error(`piglink.tests[${index}] must be an object`);
  const action = assertName(raw.action, `piglink.tests[${index}].action`);
  if (!Object.hasOwn(actions, action)) throw new Error(`piglink.tests[${index}] references unknown action ${action}`);
  return {
    name: String(raw.name ?? `${action} #${index + 1}`).trim(),
    action,
    input: cloneJson(raw.input ?? {}, `piglink.tests[${index}].input`),
    expect: Object.hasOwn(raw, 'expect') ? cloneJson(raw.expect, `piglink.tests[${index}].expect`) : undefined
  };
}

export function normalizePigLink(raw) {
  if (raw == null) return null;
  if (!plainObject(raw)) throw new Error('piglink must be an object');
  const source = String(raw.source ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!source || source.includes('..') || source.startsWith('__wurst/')) throw new Error('piglink.source must be a project-relative JavaScript file');
  const actions = {};
  for (const [rawName, spec] of Object.entries(raw.actions ?? {})) {
    const name = assertName(rawName, 'PigLink action name');
    actions[name] = normalizeAction(name, spec);
  }
  const events = {};
  for (const [rawName, spec] of Object.entries(raw.events ?? {})) {
    const name = assertName(rawName, 'PigLink event name');
    events[name] = normalizeEvent(name, spec);
  }
  if (Object.keys(actions).length === 0) throw new Error('piglink.actions must declare at least one action');
  const tests = (raw.tests ?? []).map((test, index) => normalizeTest(test, index, actions));
  return {
    format: PIGLINK_FORMAT,
    source,
    headless: raw.headless === true,
    actions,
    events,
    tests
  };
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return plainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

export function validateJsonValue(value, schema, label = '$') {
  if (!schema) return value;
  if (schema.type && !typeMatches(value, schema.type)) throw new Error(`${label} must be ${schema.type}`);
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) throw new Error(`${label} is not an allowed value`);
  if (schema.type === 'object' && plainObject(value)) {
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) throw new Error(`${label}.${required} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) validateJsonValue(value[key], child, `${label}.${key}`);
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) value.forEach((item, index) => validateJsonValue(item, schema.items, `${label}[${index}]`));
  return value;
}

export function publicPigLinkManifest(normalized, entry) {
  if (!normalized) return null;
  return {
    format: normalized.format,
    entry,
    headless: normalized.headless,
    actions: normalized.actions,
    events: normalized.events,
    tests: normalized.tests
  };
}

export function createActionRegistry(declaration, { emit = () => {} } = {}) {
  const handlers = new Map();
  const manifest = declaration ?? { actions: {}, events: {} };
  return Object.freeze({
    register(name, handler) {
      const safeName = assertName(name, 'action name');
      if (!Object.hasOwn(manifest.actions ?? {}, safeName)) throw new Error(`Action is not declared by this Wurst: ${safeName}`);
      if (typeof handler !== 'function') throw new Error(`Action handler must be a function: ${safeName}`);
      handlers.set(safeName, handler);
      return true;
    },
    async invoke(name, input = {}, context = {}) {
      const safeName = assertName(name, 'action name');
      const spec = manifest.actions?.[safeName];
      if (!spec) throw new Error(`Unknown Wurst action: ${safeName}`);
      const handler = handlers.get(safeName);
      if (!handler) throw new Error(`Wurst action is declared but not registered: ${safeName}`);
      validateJsonValue(input, spec.input, '$input');
      const result = await handler(cloneJson(input, 'action input'), context);
      const clean = cloneJson(result, 'action result');
      if (spec.output) validateJsonValue(clean, spec.output, '$output');
      return clean;
    },
    emit(name, payload = null) {
      const safeName = assertName(name, 'event name');
      const spec = manifest.events?.[safeName];
      if (!spec) throw new Error(`Unknown Wurst event: ${safeName}`);
      const clean = cloneJson(payload, 'event payload');
      if (spec.payload) validateJsonValue(clean, spec.payload, '$event');
      emit(safeName, clean);
      return true;
    },
    names() { return [...handlers.keys()]; }
  });
}
