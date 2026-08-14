export function createTrustedSurfaceRuntime({
  ipcMain,
  createView,
  getHostWindow,
  getRuntimeRenderer,
  getRuntimeViewport,
  assertWurstSender,
  authControlPreload,
  authControlHtml,
  identityControlPreload,
  identityControlHtml,
  secureTrustPresentation,
  showIdentityVerificationForContext
}) {
  const authSurfaces = new Map();
  const authSurfaceByWebContents = new Map();
  const identitySurfaces = new Map();
  const identitySurfaceByWebContents = new Map();

  const keyFor = (context, id) => `${context?.runtimeBinding ?? 'runtime'}:${id}`;

  function authSurfaceForEvent(event) {
    const surface = authSurfaceByWebContents.get(event.sender.id);
    if (!surface || surface.destroyed || !getRuntimeRenderer(surface.context)) throw new Error('Invalid Wurster Auth surface');
    return surface;
  }

  function sendAuthResultToWurst(surface, ok, extra = {}) {
    const renderer = getRuntimeRenderer(surface.context);
    if (!renderer) return;
    renderer.send('wurst:auth:result', {
      id: surface.anchorId,
      ok,
      type: surface.type,
      purpose: surface.purpose,
      target: surface.target || null,
      ...extra
    });
  }

  function authLayout(surface, expanded = surface.expanded) {
    const base = surface.baseBounds;
    const viewport = getRuntimeViewport(surface.context);
    const width = Math.max(220, Math.min(base.width, Math.max(220, viewport.width - 8)));
    const height = Math.max(60, base.height);
    const localX = Math.max(4, Math.min(base.x, Math.max(4, viewport.width - width - 4)));
    const localY = Math.max(4, Math.min(base.y, Math.max(4, viewport.height - height - 4)));
    if (!expanded) return {
      viewBounds: { x: viewport.x + localX, y: viewport.y + localY, width, height },
      controlBounds: { x: 0, y: 0, width, height },
      expanded: false
    };
    return {
      viewBounds: { x: viewport.x, y: viewport.y, width: Math.max(1, viewport.width), height: Math.max(1, viewport.height) },
      controlBounds: { x: localX, y: localY, width, height },
      expanded: true
    };
  }

  function applyAuthLayout(surface) {
    if (!surface || surface.destroyed) return;
    const host = getHostWindow();
    const layout = authLayout(surface);
    if (surface.expanded && host && !host.isDestroyed()) host.contentView.addChildView(surface.view);
    surface.view.setBounds(layout.viewBounds);
    if (!surface.view.webContents.isDestroyed()) surface.view.webContents.send('wurster:auth:layout', { ...layout.controlBounds, expanded: layout.expanded });
  }

  function destroyAuth(surface) {
    if (!surface || surface.destroyed) return;
    surface.destroyed = true;
    surface.pendingMeatphrase = null;
    authSurfaces.delete(surface.key);
    authSurfaceByWebContents.delete(surface.view.webContents.id);
    try { getHostWindow()?.contentView.removeChildView(surface.view); } catch {}
    try { surface.view.webContents.close(); } catch {}
  }

  function createAuth(context, anchor) {
    const host = getHostWindow();
    if (!host || host.isDestroyed() || !getRuntimeRenderer(context)) return null;
    const view = createView({
      preload: authControlPreload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false
    });
    const surface = {
      key: keyFor(context, anchor.id), anchorId: anchor.id, type: anchor.type, purpose: anchor.purpose,
      target: anchor.target, session: anchor.session || '', context, view,
      baseBounds: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
      expanded: false, destroyed: false, pendingIdentity: null, pendingMeatphrase: null
    };
    authSurfaces.set(surface.key, surface);
    authSurfaceByWebContents.set(view.webContents.id, surface);
    host.contentView.addChildView(view);
    applyAuthLayout(surface);
    try { view.setBackgroundColor('#00000000'); } catch {}
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    void view.webContents.loadFile(authControlHtml).then(() => applyAuthLayout(surface));
    return surface;
  }

  function updateAuth(surface, anchor) {
    Object.assign(surface, { type: anchor.type, purpose: anchor.purpose, target: anchor.target, session: anchor.session || '' });
    surface.baseBounds = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height };
    applyAuthLayout(surface);
  }

  ipcMain.on('wurst:auth:anchors', (event, rawAnchors) => {
    let context;
    try { context = assertWurstSender(event); } catch { return; }
    const anchors = Array.isArray(rawAnchors) ? rawAnchors.slice(0, 8) : [];
    const seen = new Set();
    for (const raw of anchors) {
      const id = String(raw?.id ?? '').slice(0, 80);
      const type = raw?.type === 'wurstkey' ? 'wurstkey' : 'identity';
      const requestedPurpose = String(raw?.purpose ?? '').toLowerCase();
      const purpose = type === 'wurstkey' ? 'application' : ['identity', 'filesystem', 'realm'].includes(requestedPurpose) ? requestedPurpose : 'identity';
      const width = Math.round(Number(raw?.width)); const height = Math.round(Number(raw?.height));
      const x = Math.round(Number(raw?.x)); const y = Math.round(Number(raw?.y));
      if (!id || !raw?.visible || !Number.isFinite(width) || !Number.isFinite(height) || width < 180 || height < 54 || ![x, y].every(Number.isFinite)) continue;
      const anchor = { id, type, purpose, target: String(raw?.target ?? '').slice(0, 256), session: String(raw?.session ?? '').slice(0, 32), width, height, x, y };
      const key = keyFor(context, id); seen.add(key);
      const existing = authSurfaces.get(key); if (existing) updateAuth(existing, anchor); else createAuth(context, anchor);
    }
    for (const [key, surface] of [...authSurfaces]) if (surface.context === context && !seen.has(key)) destroyAuth(surface);
  });

  function identitySurfaceForEvent(event) {
    const surface = identitySurfaceByWebContents.get(event.sender.id);
    if (!surface || surface.destroyed || !getRuntimeRenderer(surface.context)) throw new Error('Invalid Wurst Identity surface');
    return surface;
  }

  function identityLayout(surface) {
    const base = surface.baseBounds;
    const viewport = getRuntimeViewport(surface.context);
    const width = Math.max(190, Math.min(base.width, Math.max(190, viewport.width)));
    const height = Math.max(50, Math.min(base.height, 110));
    const clipX = Math.max(0, Math.min(Number(surface.clip?.x) || 0, width));
    const clipY = Math.max(0, Math.min(Number(surface.clip?.y) || 0, height));
    const clipWidth = Math.max(0, Math.min(Number(surface.clip?.width) || width, width - clipX));
    const clipHeight = Math.max(0, Math.min(Number(surface.clip?.height) || height, height - clipY));
    return {
      viewBounds: {
        x: viewport.x + base.x + clipX,
        y: viewport.y + base.y + clipY,
        width: Math.max(1, clipWidth),
        height: Math.max(1, clipHeight)
      },
      controlBounds: { x: -clipX, y: -clipY, width, height }
    };
  }

  function raiseExpandedAuth() {
    const host = getHostWindow(); if (!host || host.isDestroyed()) return;
    for (const surface of authSurfaces.values()) if (surface.expanded && !surface.destroyed) host.contentView.addChildView(surface.view);
  }

  function applyIdentityLayout(surface) {
    const host = getHostWindow(); if (!surface || surface.destroyed || !host || host.isDestroyed()) return;
    const layout = identityLayout(surface);
    surface.view.setBounds(layout.viewBounds);
    if (!surface.view.webContents.isDestroyed()) surface.view.webContents.send('wurster:identity:layout', layout.controlBounds);
    raiseExpandedAuth();
  }

  function destroyIdentity(surface) {
    if (!surface || surface.destroyed) return;
    surface.destroyed = true; identitySurfaces.delete(surface.key); identitySurfaceByWebContents.delete(surface.view.webContents.id);
    try { getHostWindow()?.contentView.removeChildView(surface.view); } catch {}
    try { surface.view.webContents.close(); } catch {}
  }

  function createIdentity(context, anchor) {
    const host = getHostWindow(); if (!host || host.isDestroyed() || !getRuntimeRenderer(context)) return null;
    const view = createView({ preload: identityControlPreload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false });
    const surface = { key: keyFor(context, anchor.id), anchorId: anchor.id, context, view, baseBounds: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }, clip: { x: anchor.clipX, y: anchor.clipY, width: anchor.clipWidth, height: anchor.clipHeight }, destroyed: false };
    identitySurfaces.set(surface.key, surface); identitySurfaceByWebContents.set(view.webContents.id, surface); host.contentView.addChildView(view);
    applyIdentityLayout(surface); try { view.setBackgroundColor('#00000000'); } catch {}
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); view.webContents.on('will-navigate', (event) => event.preventDefault());
    void view.webContents.loadFile(identityControlHtml).then(() => applyIdentityLayout(surface));
    return surface;
  }

  ipcMain.on('wurst:identity:anchors', (event, rawAnchors) => {
    let context; try { context = assertWurstSender(event); } catch { return; }
    const anchors = Array.isArray(rawAnchors) ? rawAnchors.slice(0, 8) : []; const seen = new Set();
    for (const raw of anchors) {
      const id = String(raw?.id ?? '').slice(0, 80); const width = Math.round(Number(raw?.width)); const height = Math.round(Number(raw?.height));
      const x = Math.round(Number(raw?.x)); const y = Math.round(Number(raw?.y));
      const clipX = Math.round(Number(raw?.clipX) || 0); const clipY = Math.round(Number(raw?.clipY) || 0);
      const clipWidth = Math.round(Number(raw?.clipWidth) || width); const clipHeight = Math.round(Number(raw?.clipHeight) || height);
      if (!id || !raw?.visible || !Number.isFinite(width) || !Number.isFinite(height) || width < 190 || height < 50 || ![x, y, clipX, clipY, clipWidth, clipHeight].every(Number.isFinite) || clipWidth < 1 || clipHeight < 1) continue;
      const anchor = { id, width, height, x, y, clipX, clipY, clipWidth, clipHeight }; const key = keyFor(context, id); seen.add(key);
      const existing = identitySurfaces.get(key);
      if (existing) { existing.baseBounds = { x, y, width, height }; existing.clip = { x: clipX, y: clipY, width: clipWidth, height: clipHeight }; applyIdentityLayout(existing); } else createIdentity(context, anchor);
    }
    for (const [key, surface] of [...identitySurfaces]) if (surface.context === context && !seen.has(key)) destroyIdentity(surface);
  });

  ipcMain.handle('wurster:identity-control:context', async (event) => {
    const surface = identitySurfaceForEvent(event);
    return { id: surface.context.manifest.id, name: surface.context.manifest.name, version: surface.context.manifest.version, trust: secureTrustPresentation(surface.context) };
  });
  ipcMain.handle('wurster:identity-control:verify', async (event) => { const surface = identitySurfaceForEvent(event); await showIdentityVerificationForContext(surface.context); return true; });

  return {
    authSurfaceForEvent,
    identitySurfaceForEvent,
    sendAuthResultToWurst,
    applyAuthSurfaceLayout: applyAuthLayout,
    layoutContext(context) {
      for (const surface of authSurfaces.values()) if (surface.context === context && !surface.destroyed) applyAuthLayout(surface);
      for (const surface of identitySurfaces.values()) if (surface.context === context && !surface.destroyed) applyIdentityLayout(surface);
    },
    cleanupContext(context) {
      for (const surface of [...authSurfaces.values()]) if (surface.context === context) destroyAuth(surface);
      for (const surface of [...identitySurfaces.values()]) if (surface.context === context) destroyIdentity(surface);
    },
    destroyAll() {
      for (const surface of [...authSurfaces.values()]) destroyAuth(surface);
      for (const surface of [...identitySurfaces.values()]) destroyIdentity(surface);
    }
  };
}
