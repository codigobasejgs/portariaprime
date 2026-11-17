import { renderReceiptPdf } from '../../api/_lib/receipt-pdf';
import { TENANT } from './mode';
import { store, uid } from './store';
import { DEMO_SIG, demoSignature, myUnits } from './rpc';
import { COURIER_HANDLERS } from './rpc-couriers';

/** Local stand-in for /api/* on /demonstracao. Unlisted paths fail closed. */
const MARK = 'DEMONSTRAÇÃO · DADOS FICTÍCIOS';
type DemoMsg = { id: string; fromMe: boolean; at: number; text: string; media: string | null; fileName: string | null };
const DEMO_CHATS: { jid: string; name: string; unit: string; phone: string; msgs: DemoMsg[] }[] = [];
const fail = (m = 'Indisponível na demonstração.'): never => { throw new Error(m); };
const bytes = async (path: unknown) => { const b = typeof path === 'string' ? store.files.get(path) : undefined; return b ? new Uint8Array(await b.arrayBuffer()) : undefined; };

export async function demoApi<T = any>(path: string, body: any = {}): Promise<T> {
  await Promise.resolve();
  if (body?.tenantId && body.tenantId !== TENANT) fail('Condomínio indisponível.');
  const role = store.user.role;
  switch (path) {
    case '/api/ocr/analyze-label':
      if (role === 'morador') fail('Sem permissão.');
      // CNH fictícia; a foto (opt-in) não sai do navegador na demonstração.
      if (body.kind === 'cnh') return { kind: 'cnh', full_name: 'Rodrigo Fictício Santos', cpf: '529.982.247-25', cnh_number: '01234567890', category: 'AB', confidence: 93, alerts: [] } as T;
      if (body.kind === 'cnh-photo-view') {
        const { path } = COURIER_HANDLERS.courier_photo_reveal({ p_tenant: TENANT, p_courier: body.courierId, p_reason: body.reason });
        const blob = store.files.get(path) || fail('Foto não encontrada.');
        return { url: URL.createObjectURL(blob!), expiresIn: 60 } as T;
      }
      if (body.kind === 'cnh-photo') {
        // Mesma ordem do servidor: autoriza, guarda o arquivo, vincula; falha no vínculo descarta o arquivo novo.
        const { has_photo } = COURIER_HANDLERS.courier_photo_authorize({ p_tenant: TENANT, p_courier: body.courierId });
        if (has_photo) fail('Foto já guardada para este entregador.');
        const key = `couriers/${body.courierId}`;
        const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(body.imageBase64 || '')) || fail('Envie a foto em JPEG.');
        store.files.set(key, new Blob([Uint8Array.from(atob(m![1]), (ch) => ch.charCodeAt(0))], { type: 'image/jpeg' }));
        try { COURIER_HANDLERS.courier_attach_photo({ p_tenant: TENANT, p_courier: body.courierId }); }
        catch (e) { store.files.delete(key); throw e; }
        return { saved: true } as T;
      }
      {
        // Etiquetas fictícias variadas (escolhidas pela própria imagem): a maioria confere; algumas não identificam a
        // unidade, para o recebimento em lote mostrar acertos e pendências como no uso real.
        // Fora do lote (etiqueta de exemplo do recebimento normal): sempre a mesma leitura, João Silva · A 101.
        const h = typeof body.demoVariant === 'number' ? body.demoVariant : 0;
        const L = [
          ['Correios', 'João Silva', 'A', '101', 1, 'matched'], ['Mercado Livre', 'Marina Costa', 'A', '102', 2, 'matched'],
          ['Amazon', 'Rafael Lima', 'A', '201', 3, 'matched'], ['Shopee', 'Fulano Desconhecido', null, null, 0, 'not_found'],
          ['Loggi', 'Luciana Prado', 'B', '101', 5, 'matched'], ['Correios', 'Ricardo T.', 'B', '2O2', 0, 'ambiguous'],
        ] as const;
        const [carrier, recipientName, block, unit, n, status] = L[h % L.length];
        return { carrier, trackingCode: `DM${String(5550000 + (h % 9999)).padStart(7, '0')}BR`, recipientName, senderName: 'Loja Exemplo', block, unit,
          complement: null, orderNumber: null, invoiceNumber: null, evidence: [{ field: 'recipient', text: recipientName }], alerts: [], confidence: status === 'matched' ? 92 : 48,
          match: { status, unit_id: n ? uid(n) : null, alerts: [] } } as T;
      }
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
    case '/api/billing/contract_sync': {
      // "Já assinei": simula a assinatura do síndico e, na consulta seguinte, a da Contratada.
      if (role !== 'admin') fail('Sem permissão.');
      const now = new Date().toISOString();
      if (!DEMO_SIG.contractor) DEMO_SIG.contractor = now; else if (!DEMO_SIG.owner) DEMO_SIG.owner = now;
      return demoSignature() as T;
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
    case '/api/whatsapp/chat-list':
    case '/api/whatsapp/chat-messages':
    case '/api/whatsapp/chat-send':
    case '/api/whatsapp/chat-media': {
      // Conversas fictícias do WhatsApp dos avisos; envio fica só nesta aba (nada sai do navegador).
      if (role !== 'admin') fail('Sem permissão.');
      const now = Date.now(), m = 60_000;
      if (!DEMO_CHATS.length) DEMO_CHATS.push(
        { jid: '5500000000001@s.whatsapp.net', name: 'João Silva', unit: 'A 101', phone: '+55 (00) 0000-0001', msgs: [
          { id: 'D1', fromMe: true, at: now - 90 * m, text: 'Olá, João! Chegou uma encomenda dos Correios para A 101.', media: null, fileName: null },
          { id: 'D2', fromMe: false, at: now - 60 * m, text: 'Obrigado! Posso retirar depois das 19h?', media: null, fileName: null }] },
        { jid: '5500000000002@s.whatsapp.net', name: 'Marina Costa', unit: 'A 102', phone: '+55 (00) 0000-0002', msgs: [
          { id: 'D3', fromMe: true, at: now - 300 * m, text: 'Olá, Marina! Sua encomenda do Mercado Livre foi entregue. Comprovante em anexo.', media: null, fileName: null }] });
      const chats = DEMO_CHATS;
      const c = path === '/api/whatsapp/chat-list' ? null : chats.find((x) => x.jid === body.jid) || fail('Conversa não encontrada neste WhatsApp.');
      if (path === '/api/whatsapp/chat-list') {
        return { chats: chats.map((x) => { const l = x.msgs[x.msgs.length - 1]; return { jid: x.jid, name: x.name, unit: x.unit, phone: x.phone,
          unread: l.fromMe ? 0 : 1, at: l.at, last: { text: l.text, media: l.media, fromMe: l.fromMe } }; }).sort((a, b) => b.at - a.at) } as T;
      }
      if (path === '/api/whatsapp/chat-messages') return { messages: [...c!.msgs].reverse(), page: 1, pages: 1 } as T;
      if (path === '/api/whatsapp/chat-media') fail('Arquivos não abrem na demonstração.');
      if (!String(body.text || '').trim() && !body.file) fail('Escreva a mensagem.');
      c!.msgs.push({ id: `D${now}`, fromMe: true, at: now, text: String(body.text || '').slice(0, 4000), media: body.file ? (String(body.mime).startsWith('video') ? 'video' : String(body.mime).startsWith('image') ? 'image' : 'document') : null, fileName: body.fileName || null });
      return { sent: true, id: null } as T;
    }
    default:
      return fail();
  }
}
