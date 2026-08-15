const DEFAULT_OPEN_TIMEOUT_MS = 8000;

export function isWurstDevToolsShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return false;
  if (String(input.key ?? '').toLowerCase() !== 'i') return false;
  if (platform === 'darwin') return Boolean(input.meta && input.alt && !input.control && !input.shift);
  return Boolean(input.control && input.shift && !input.meta && !input.alt);
}


function alive(value) {
  return Boolean(value) && !(typeof value.isDestroyed === 'function' && value.isDestroyed());
}

function waitForEvent(emitter, eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emitter.removeListener?.(eventName, onEvent);
      fn(value);
    };
    const onEvent = () => finish(resolve, true);
    const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
    emitter.once(eventName, onEvent);
  });
}

async function closeForeignDevTools(target, timeoutMs) {
  if (!target.isDevToolsOpened?.()) return;
  const closed = waitForEvent(target, 'devtools-closed', timeoutMs).catch(() => false);
  target.closeDevTools();
  await closed;
}

export function createDesktopDevToolsRuntime({ BrowserWindow, timeoutMs = DEFAULT_OPEN_TIMEOUT_MS } = {}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('Desktop DevTools runtime requires BrowserWindow');

  let owned = null;
  let sequence = 0;

  function state() {
    if (!owned) return null;
    return {
      targetId: owned.targetId,
      windowId: owned.window?.id ?? null,
      opening: Boolean(owned.opening)
    };
  }

  function destroyOwnedWindow(entry) {
    if (!entry?.window || entry.window.isDestroyed?.()) return;
    try { entry.window.destroy(); } catch {}
  }

  function release(entry, { closeTarget = true, destroyWindow = true } = {}) {
    if (!entry || owned !== entry) return;
    owned = null;
    if (closeTarget && alive(entry.target)) {
      try {
        if (entry.target.isDevToolsOpened?.()) entry.target.closeDevTools();
      } catch {}
    }
    if (destroyWindow) destroyOwnedWindow(entry);
  }

  function close() {
    const entry = owned;
    if (!entry) return false;
    release(entry);
    return true;
  }

  async function open(target, { title = 'Wurst Developer Tools' } = {}) {
    if (!alive(target)) throw new Error('Wurst Developer Tools target is unavailable');
    if (typeof target.setDevToolsWebContents !== 'function' || typeof target.openDevTools !== 'function') {
      throw new Error('Wurst renderer does not support Developer Tools');
    }

    if (owned?.targetId === target.id && alive(owned.window) && target.isDevToolsOpened?.()) {
      owned.window.show?.();
      owned.window.focus?.();
      return state();
    }

    close();
    // Electron can retain an internally managed DevTools target even when its
    // detached native window is lost or invisible. Never interpret that ghost
    // state as a user-visible toggle: reset it before installing our own host.
    try {
      await closeForeignDevTools(target, timeoutMs);
    } catch (error) {
      throw new Error(`Could not reset stale Wurst Developer Tools: ${error?.message || String(error)}`);
    }

    const devToolsWindow = new BrowserWindow({
      title,
      width: 1180,
      height: 820,
      minWidth: 640,
      minHeight: 420,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        webviewTag: false
      }
    });
    const entry = {
      token: ++sequence,
      target,
      targetId: target.id,
      window: devToolsWindow,
      opening: true
    };
    owned = entry;

    const targetDestroyed = () => release(entry, { closeTarget: false, destroyWindow: true });
    const targetClosed = () => release(entry, { closeTarget: false, destroyWindow: true });
    const windowClose = () => release(entry, { closeTarget: true, destroyWindow: false });
    target.once?.('destroyed', targetDestroyed);
    target.on?.('devtools-closed', targetClosed);
    devToolsWindow.once?.('close', windowClose);
    devToolsWindow.once?.('closed', windowClose);
    devToolsWindow.webContents?.on?.('before-input-event', (event, input) => {
      if (!isWurstDevToolsShortcut(input)) return;
      event.preventDefault();
      close();
    });

    try {
      target.setDevToolsWebContents(devToolsWindow.webContents);
      const opened = waitForEvent(target, 'devtools-opened', timeoutMs);
      target.openDevTools({ mode: 'detach', activate: false, title });
      await opened;
      if (owned !== entry || !alive(target) || !alive(devToolsWindow)) throw new Error('Wurst Developer Tools closed while opening');
      entry.opening = false;
      devToolsWindow.center?.();
      devToolsWindow.show?.();
      devToolsWindow.focus?.();
      return state();
    } catch (error) {
      release(entry, { closeTarget: true, destroyWindow: true });
      throw new Error(`Could not open Wurst Developer Tools: ${error?.message || String(error)}`);
    }
  }

  async function toggle(target, options = {}) {
    if (owned?.targetId === target?.id && alive(owned.window) && target?.isDevToolsOpened?.()) {
      close();
      return null;
    }
    return open(target, options);
  }

  return Object.freeze({ open, toggle, close, state });
}
