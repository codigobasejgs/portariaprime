import { DEMO } from './mode';

if (DEMO) {
  const allowed = (raw: string) => {
    const u = new URL(raw, location.href);
    return ['blob:', 'data:'].includes(u.protocol) || (u.origin === location.origin && !/^\/api(?:\/|$)/.test(u.pathname));
  };
  const denied = () => new Error('Rede indisponível na demonstração.');
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => allowed(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    ? originalFetch(input, init) : Promise.reject(denied());
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    if (!allowed(String(url))) throw denied();
    return (open as any).call(this, method, url, ...rest);
  };
  navigator.sendBeacon = () => false;
  // No realtime, push, or worker registration; the local adapter emits its own change events.
  window.WebSocket = class { constructor() { throw denied(); } } as any;
  window.EventSource = class { constructor() { throw denied(); } } as any;
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = () => Promise.reject(denied());
    navigator.serviceWorker.getRegistration = async () => undefined;
    navigator.serviceWorker.getRegistrations = async () => [];
  }
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = "connect-src 'self' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'none'; form-action 'none'; worker-src 'none'";
  document.head.append(meta);
}
