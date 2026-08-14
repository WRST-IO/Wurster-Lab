export function pigFsPath(value = '/') {
  const raw = String(value ?? '').replaceAll('\\', '/').trim();
  if (raw.includes('\0')) throw new Error(`Invalid PigFS path: ${value}`);
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error(`Unsafe PigFS path: ${value}`);
  return `/${parts.join('/')}`;
}
