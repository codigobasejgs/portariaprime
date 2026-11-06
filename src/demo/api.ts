import { renderReceiptPdf } from '../../api/_lib/receipt-pdf';
import { TENANT } from './mode';
import { store, uid } from './store';
import { myUnits } from './rpc';

/** Local stand-in for /api/* on /demonstracao. Unlisted paths fail closed. */
const MARK = 'DEMONSTRAÇÃO · DADOS FICTÍCIOS';
const fail = (m = 'Indisponível na demonstração.'): never => { throw new Error(m); };
const bytes = async (path: unknown) => { const b = typeof path === 'string' ? store.files.get(path) : undefined; return b ? new Uint8Array(await b.arrayBuffer()) : undefined; };

export async function demoApi<T = any>(path: string, body: any = {}): Promise<T> {
  await Promise.resolve();
  if (body?.tenantId && body.tenantId !== TENANT) fail('Condomínio indisponível.');
  const role = store.user.role;
  switch (path) {
    case '/api/ocr/analyze-label':
      if (role === 'morador') fail('Sem permissão.');
      return { carrier: 'Correios', trackingCode: 'DM5550001BR', recipientName: 'João Silva', senderName: 'Loja Exemplo', block: 'A', unit: '101',
        complement: null, orderNumber: null, invoiceNumber: null, evidence: [{ field: 'recipient', text: 'João Silva' }], alerts: [], confidence: 92,
        match: { status: 'matched', unit_id: uid(1), alerts: [] } } as T;
    case '/api/receipts/download': {
      const r = store.s.receipts.find((x) => x.package_id === body.packageId);
      const p = store.pkg(body.packageId);
      if (!r || !p || (role === 'morador' && !myUnits().includes(p.unit_id!))) fail('Comprovante não encontrado.');
      const pdf = await renderReceiptPdf({
        protocol: r!.protocol, package_id: p!.id, issued_at: r!.issued_at, recipient_name: p!.recipient_name, verify_code: null, verify_url: null,
        layout: { title: `Comprovante de entrega — ${MARK}`, message: `${MARK}. Documento sem validade e sem validação pública.`, footer: MARK,
          tenant_name: 'Jardins Prime (demonstração)', timezone: 'America/Sao_Paulo' },
        snapshot: r!.snapshot as any,
      }, { signature: await bytes(r!.snapshot.signature_path), photo: await bytes(r!.snapshot.handover_path) });
      return { status: 'ready', url: URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' })) } as T;
    }
    case '/api/team/resident-reset': {
      if (role !== 'admin') fail('Sem permissão.');
      const u = store.s.users.find((x) => x.id === body.userId) || fail('Morador não encontrado.');
      return { email: u.email } as T;
    }
    case '/api/invitations/send': {
      if (role !== 'admin') fail('Sem permissão.');
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('E-mail inválido.');
      store.s.invitations.unshift({ id: crypto.randomUUID(), email, role: 'morador', unit_id: body.unitId, created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), accepted_at: null, revoked_at: null });
      store.changed('invitations');
      return { manualLink: 'https://exemplo.invalid/convite-ficticio' } as T;
    }
    default:
      return fail();
  }
}
