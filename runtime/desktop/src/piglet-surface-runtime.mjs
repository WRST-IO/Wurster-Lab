import crypto from 'node:crypto';
import { classifyRisk, openWurstFile, openWurstRangeSource, verifyPackageSignatureFromReader } from '@wurster/format';
import { createPigletBackingFileFromSource } from './piglet-backing-runtime.mjs';

function normalizedBounds(raw, hostBounds) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const x = Math.max(0, Math.floor(Number(source.x) || 0));
  const y = Math.max(0, Math.floor(Number(source.y) || 0));
  const width = Math.max(1, Math.min(Math.floor(Number(source.width) || hostBounds.width), Math.max(1, hostBounds.width - x)));
  const height = Math.max(1, Math.min(Math.floor(Number(source.height) || hostBounds.height), Math.max(1, hostBounds.height - y)));
  return { x, y, width, height };
}

export function createPigletSurfaceManager({
  getHostWindow,
  createView,
  sessionForChild,
  configureSession,
  authorizePackage,
  bindContext,
  unbindContext,
  preload,
  storage,
  loadSealedBootstrap,
  destroyProtectionHandle,
  cleanupContextUi,
  layoutContextUi
}) {
  const surfaces = new Map();

  async function open(parentContext, descriptor, source, options = {}) {
    const existing = [...surfaces.values()].find((surface) => !surface.closed && surface.parentContext === parentContext && surface.descriptor.ref === descriptor.ref);
    if (existing) {
      if (options.bounds) {
        existing.fill = false;
        existing.view.setBounds(normalizedBounds(options.bounds, getHostWindow().getContentBounds()));
        layoutContextUi(existing.context);
      }
      existing.view.webContents.focus();
      return describe(existing);
    }
    const hostWindow = getHostWindow();
    if (!hostWindow || hostWindow.isDestroyed()) throw new Error('Piglet host window is unavailable');
    const runtimeSource = await storage.prepareRuntimeSource(parentContext, descriptor, source);
    let backing = null;
    let reader = await openWurstRangeSource(runtimeSource.source);
    let view = null;
    try {
      const manifest = reader.manifest;
      const signature = await verifyPackageSignatureFromReader(reader);
      const risk = classifyRisk(manifest);
      const authorization = await authorizePackage(manifest, risk, signature);
      const handle = `piglet-${crypto.randomUUID()}`;
      const context = {
        filePath: null,
        reader,
        manifest,
        signature,
        risk,
        publisherTrust: authorization.publisherTrust,
        runtimeBinding: `piglet:${parentContext.manifest.id}:${handle}`,
        applicationProtectionHandle: null,
        applicationSessionTimer: null,
        wurstFsStore: null,
        wurstFsMaintenance: null,
        wurstFsHygieneTimer: null,
        sealedAppMap: null,
        identitySession: null,
        wurstIdentityMaterial: null,
        filesystemIdentityTimer: null,
        bootstrapWindow: null,
        bootstrapWebContents: null,
        parentContext,
        pigletHandle: handle,
        readOnlyPackage: false,
        pigletPersistence: runtimeSource.path ? {
          source: runtimeSource,
          async flush() {
            const updated = await context.pigletBacking.bytes();
            await storage.persistRuntimeSource(parentContext, runtimeSource, updated);
          }
        } : null,
        pigletBacking: null,
        async ensurePigletBacking() {
          if (context.pigletBacking) return context.pigletBacking;
          if (runtimeSource.path && !runtimeSource.expectedSha256) runtimeSource.expectedSha256 = await storage.fingerprintRuntimeSource(runtimeSource.source);
          const created = await createPigletBackingFileFromSource(runtimeSource.source);
          const replacement = await openWurstFile(created.filePath);
          await context.reader.close().catch(() => {});
          context.reader = replacement;
          context.filePath = created.filePath;
          context.pigletBacking = created;
          backing = created;
          return created;
        }
      };
      const childSession = sessionForChild(manifest, `${parentContext.manifest.id}:${descriptor.ref}`);
      configureSession(childSession, context);
      view = createView({
        session: childSession,
        preload,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: true,
        spellcheck: false,
        webviewTag: false
      });
      const surface = { handle, parentContext, context, descriptor, view, fill: !options.bounds, closed: false };
      context.pigletSurface = surface;
      bindContext(view.webContents, context);
      hostWindow.contentView.addChildView(view);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('wurst://app/')) event.preventDefault(); });
      const hostBounds = hostWindow.getContentBounds();
      view.setBounds(normalizedBounds(options.bounds, hostBounds));
      surfaces.set(handle, surface);
      if (manifest?.application?.protection === 'sealed') {
        await context.ensurePigletBacking();
        context.bootstrapWebContents = view.webContents;
        const sealedBootstrapHtml = await loadSealedBootstrap();
        await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sealedBootstrapHtml)}`);
      } else {
        await view.webContents.loadURL(`wurst://app/${manifest.entry}`);
      }
      return describe(surface);
    } catch (error) {
      if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close();
      await reader.close().catch(() => {});
      if (backing) await backing.destroy().catch(() => {});
      throw error;
    }
  }

  function describe(surface) {
    return {
      handle: surface.handle,
      ref: surface.descriptor.ref,
      application: structuredClone(surface.descriptor.application),
      signature: structuredClone(surface.descriptor.signature),
      bounds: surface.view.getBounds(),
      focused: surface.view.webContents.isFocused(),
      fill: surface.fill
    };
  }

  function requireSurface(parentContext, rawHandle) {
    const surface = surfaces.get(String(rawHandle ?? ''));
    if (!surface || surface.closed || surface.parentContext !== parentContext) throw new Error('Unknown Piglet surface handle');
    return surface;
  }

  async function closeSurface(surface) {
    if (!surface || surface.closed) return false;
    surface.closed = true;
    surfaces.delete(surface.handle);
    cleanupContextUi(surface.context);
    unbindContext(surface.view.webContents);
    const hostWindow = getHostWindow();
    try { hostWindow?.contentView.removeChildView(surface.view); } catch {}
    try { if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close(); } catch {}
    if (surface.context.wurstFsStore?.closeFile) await surface.context.wurstFsStore.closeFile().catch(() => {});
    else if (surface.context.wurstFsStore?.close) surface.context.wurstFsStore.close();
    if (surface.context.applicationProtectionHandle) await destroyProtectionHandle(surface.context.applicationProtectionHandle).catch(() => {});
    await surface.context.reader.close().catch(() => {});
    await surface.context.pigletBacking?.destroy().catch(() => {});
    return true;
  }

  return {
    open,
    list: (context) => [...surfaces.values()].filter((surface) => surface.parentContext === context && !surface.closed).map(describe),
    setBounds(context, handle, bounds) {
      const surface = requireSurface(context, handle);
      surface.fill = false;
      surface.view.setBounds(normalizedBounds(bounds, getHostWindow().getContentBounds()));
      layoutContextUi(surface.context);
      return describe(surface);
    },
    focus(context, handle) { const surface = requireSurface(context, handle); surface.view.webContents.focus(); return describe(surface); },
    close: (context, handle) => closeSurface(requireSurface(context, handle)),
    closeContext: async (context) => { for (const surface of [...surfaces.values()]) if (surface.parentContext === context || surface.context === context) await closeSurface(surface); },
    closeChildContext: (context) => closeSurface(context?.pigletSurface),
    layoutFillSurfaces() {
      const hostWindow = getHostWindow();
      if (!hostWindow || hostWindow.isDestroyed()) return;
      const bounds = hostWindow.getContentBounds();
      for (const surface of surfaces.values()) if (surface.fill && !surface.closed) {
        surface.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
        layoutContextUi(surface.context);
      }
    }
  };
}
