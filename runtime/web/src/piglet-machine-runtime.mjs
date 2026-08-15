export async function mountWebMachineSession(session) {
  if (typeof document === 'undefined' || !navigator.serviceWorker) throw new Error('Wurster Web machine runtime requires a browser with Service Worker support');
  session.signature = await session.reader.verifySignature();
  if (session.signature.status === 'invalid') throw new Error(`Wurst signature is invalid: ${session.signature.error || 'verification failed'}`);
  const swUrl = session.options.serviceWorkerUrl || '/wurster-sw.js';
  const swScope = session.options.serviceWorkerScope || '/';
  const registration = await navigator.serviceWorker.register(swUrl, { scope: swScope });
  await navigator.serviceWorker.ready;
  addEventListener('message', session._boundMessage);
  navigator.serviceWorker.addEventListener('message', session._boundSw);
  (registration.active || registration.waiting || registration.installing)?.postMessage({ type: 'wurster-register-session', sessionId: session.id });
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.hidden = true;
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener('load', resolve, { once: true });
    frame.addEventListener('error', () => reject(new Error('Wurst machine frame failed to load')), { once: true });
  });
  frame.src = `${session._virtualBase()}/machine/index.html`;
  (document.body || document.documentElement).append(frame);
  session.frame = frame;
  await loaded;
  return session;
}
