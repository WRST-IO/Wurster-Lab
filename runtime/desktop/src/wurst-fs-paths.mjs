export function dataFsPath(value = '/data') {
  const raw = String(value ?? '').replaceAll('\\', '/').trim();
  const normalized = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === 'data') return 'data';
  if (normalized.includes('\0')) throw new Error(`Invalid WurstFS path: ${value}`);
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe WurstFS path: ${value}`);
  const safe = parts.join('/');
  return safe.startsWith('data/') ? safe : `data/${safe}`;
}
