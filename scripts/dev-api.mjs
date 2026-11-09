// Runtime local para os MESMOS handlers Web Request/Response usados pela Vercel.
// Não substitui a homologação no runtime Vercel. Não carrega o .env legado.
// Uso: node --env-file=.env.api.local --import tsx scripts/dev-api.mjs
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const routes = {
  '/api/billing/checkout': '../api/billing/[action].ts',
  '/api/billing/order': '../api/billing/[action].ts',
  '/api/billing/reconcile': '../api/billing/[action].ts',
  ...Object.fromEntries(['contract_accept', 'contract_verify', 'contract_code', 'contract_pdf', 'contract_resend'].map(action => [`/api/billing/${action}`, '../api/billing/[action].ts'])),
  '/api/webhooks/infinitepay': '../api/webhooks/infinitepay.ts',
  '/api/jobs/tick': '../api/jobs/tick.ts',
  '/api/invitations/send': '../api/invitations/[action].ts',
  '/api/team/create': '../api/invitations/[action].ts',
  '/api/team/password': '../api/invitations/[action].ts',
  '/api/team/resident-reset': '../api/invitations/[action].ts',
  ...Object.fromEntries(['preview', 'signup', 'login', 'photo'].map(op => [`/api/team/porter-${op}`, '../api/invitations/[action].ts'])),
  '/api/ocr/analyze-label': '../api/ocr/analyze-label.ts',
  '/api/contact': '../api/public/[action].ts',
  '/api/funnel': '../api/public/[action].ts',
  '/api/quote': '../api/public/[action].ts',
  '/api/plan-request': '../api/public/[action].ts',
  '/api/public/kiosk-pilot': '../api/public/[action].ts',
  ...Object.fromEntries(['attachment', 'proposal_pdf', 'send_proposal'].map(action => [`/api/commercial/${action}`, '../api/commercial/[action].ts'])),
  '/api/platform/users': '../api/platform/users.ts',
  ...Object.fromEntries(['manifest', 'page', 'info'].map(action => [`/api/portal/${action}`, '../api/portal/[action].ts'])),
  ...Object.fromEntries(['download', 'preview'].map(action => [`/api/receipts/${action}`, '../api/receipts/[action].ts'])),
  ...Object.fromEntries(['pair', 'context', 'preregister', 'ocr', 'receive', 'kiosk-enroll', 'kiosk-sync', 'kiosk-ack', 'kiosk-event'].map(action => [`/api/totem/${action}`, '../api/totem/[action].ts'])),
  ...Object.fromEntries(['connect', 'status', 'test'].map(action => [`/api/whatsapp/${action}`, '../api/whatsapp/[action].ts'])),
};

export function createApiServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = routes[url.pathname];
      if (!file) { res.writeHead(404).end(); return; }
      const module = await import(new URL(file, import.meta.url).href);
      const handler = module[req.method];
      if (!handler) { res.writeHead(405, { Allow: Object.keys(module).filter(k => /^(GET|POST)$/.test(k)).join(', ') }).end(); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const request = new Request(url, {
        method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Falha no runtime local da API.' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.API_PORT || 3019);
  createApiServer().listen(port, '127.0.0.1', () => console.log(`API local: http://127.0.0.1:${port}`));
}
