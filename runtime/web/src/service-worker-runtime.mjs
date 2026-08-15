export async function waitForServiceWorkerControl(serviceWorkerContainer, { timeoutMs = 5000 } = {}) {
  if (!serviceWorkerContainer) throw new Error('Wurster Web Service Worker container is unavailable');
  if (serviceWorkerContainer.controller) return serviceWorkerContainer.controller;
  await new Promise((resolve, reject) => {
    let settled = false;
    const onChange = () => serviceWorkerContainer.controller && finish();
    const timer = setTimeout(() => finish(new Error('Wurster Web Service Worker did not take control of the runtime page')), timeoutMs);
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      serviceWorkerContainer.removeEventListener?.('controllerchange', onChange);
      error ? reject(error) : resolve();
    };
    serviceWorkerContainer.addEventListener?.('controllerchange', onChange);
    onChange();
  });
  if (!serviceWorkerContainer.controller) throw new Error('Wurster Web Service Worker is active but does not control the runtime page');
  return serviceWorkerContainer.controller;
}

export async function registerServiceWorkerSession(worker, sessionId, { timeoutMs = 3000 } = {}) {
  if (!worker?.postMessage) throw new Error('Wurster Web Service Worker controller is unavailable');
  const channel = new MessageChannel();
  try {
    const acknowledged = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Wurster Web Service Worker did not register the Wurst session')), timeoutMs);
      channel.port1.onmessage = (event) => {
        const data = event.data || {};
        if (data.type !== 'wurster-session-registered' || String(data.sessionId || '') !== String(sessionId)) return;
        clearTimeout(timer);
        data.ok === false ? reject(new Error(data.error || 'Wurster Web Service Worker rejected the Wurst session')) : resolve(true);
      };
      channel.port1.start?.();
    });
    worker.postMessage({ type: 'wurster-register-session', sessionId: String(sessionId) }, [channel.port2]);
    await acknowledged;
    return true;
  } finally {
    channel.port1.close?.();
  }
}
