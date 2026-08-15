const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32']);

export function autoUpdateEnabled(settings) {
  return settings?.updates?.autoUpdate !== false;
}

export function autoUpdateSupported({ isPackaged, platform }) {
  return Boolean(isPackaged) && SUPPORTED_PLATFORMS.has(platform);
}

function finitePercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

export async function runStartupAutoUpdate({
  isPackaged,
  platform,
  settings,
  loadUpdater,
  onState = async () => {},
  settleDelayMs = 650,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (!autoUpdateEnabled(settings)) return { status: 'disabled' };
  if (!autoUpdateSupported({ isPackaged, platform })) return { status: 'unsupported' };

  let updater = null;
  let progressListener = null;
  let errorListener = null;
  const emitState = async (state) => {
    try { await onState(state); } catch {}
  };

  try {
    updater = await loadUpdater();
    if (!updater?.checkForUpdates || !updater?.downloadUpdate || !updater?.quitAndInstall) {
      throw new Error('Electron updater is unavailable');
    }

    updater.autoDownload = false;
    updater.autoInstallEvent = 'manual';
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;

    progressListener = (progress = {}) => {
      void emitState({
        phase: 'downloading',
        percent: finitePercent(progress.percent),
        bytesPerSecond: Number(progress.bytesPerSecond) || 0,
        transferred: Number(progress.transferred) || 0,
        total: Number(progress.total) || 0
      });
    };
    errorListener = () => {};
    updater.on?.('download-progress', progressListener);
    updater.on?.('error', errorListener);

    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) return { status: 'current', version: result?.updateInfo?.version ?? null };

    const version = String(result.updateInfo?.version ?? '').trim() || null;
    await emitState({ phase: 'available', percent: 0, version });
    await updater.downloadUpdate(result.cancellationToken);
    await emitState({ phase: 'ready', percent: 100, version });
    if (settleDelayMs > 0) await sleep(settleDelayMs);
    updater.quitAndInstall();
    return { status: 'installing', version };
  } catch (error) {
    await emitState({ phase: 'error', percent: 0, message: error?.message || String(error) });
    return { status: 'error', error };
  } finally {
    if (updater && progressListener) updater.off?.('download-progress', progressListener);
    if (updater && errorListener) updater.off?.('error', errorListener);
  }
}
