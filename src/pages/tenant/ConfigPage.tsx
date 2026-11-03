import React, { useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { useTenant } from '../../lib/tenant';
import { navigate, query } from '../../lib/router';
import { dateTime } from '../../lib/format';
import { Alert, Input, Select } from '../../components/ui';
import { ReceiptLayoutCard } from './ReceiptLayoutCard';
import { PortalCard } from './PortalCard';
import { AssinaturaPage } from './AssinaturaPage';
import { BrandingCard, ChannelsCard, NotificationHealthCard, StorageCard, TotemCard, WhatsAppCard } from './config/cards';
import { TeamCard } from './config/TeamCard';
import { OrgLinkCard } from './config/OrgLinkCard';
import { RemindersCard } from './config/RemindersCard';
import { SecurityCard } from './config/SecurityCard';
import { CondoCard } from './config/CondoCard';
import { DevicesCard } from './config/DevicesCard';
import { PrivacyTermCard } from './config/PrivacyTermCard';
import { DivulgacaoCard } from './config/DivulgacaoCard';

type T = ReturnType<typeof useTenant>;
interface Mod { id: string; title: string; desc: string; keys: string; allowed: (t: T) => boolean; render: (t: T) => React.ReactNode }

const settings = (t: T) => t.can('settings');

/**
 * Configurações do condomínio: índice com busca + uma página por módulo
 * (/c/{slug}/configuracoes?m={id}). Os cards são os mesmos de antes, só reorganizados.
 */
export const MODULES: Mod[] = [
  { id: 'condominio', title: 'Condomínio', desc: 'Nome, CNPJ/CPF, contatos e fuso horário.', keys: 'dados cadastrais cnpj cpf endereco contato fuso horario nome',
    allowed: settings, render: () => <CondoCard /> },
  { id: 'identidade', title: 'Identidade visual', desc: 'Logo principal, cores, tema e prévia.', keys: 'marca logo cores tema aparencia nome exibido',
    allowed: settings, render: () => <BrandingCard /> },
  { id: 'portal', title: 'Portal e aplicativo', desc: 'Link público, QR de acesso, ícone do app e divulgação aos moradores.', keys: 'link endereco qr compartilhar app pwa instalar icone autocadastro divulgacao cartaz comunicado whatsapp elevador mural',
    allowed: settings, render: () => <><PortalCard /><DivulgacaoCard /></> },
  { id: 'operacao', title: 'Operação e armazenamento', desc: 'Portarias, estantes, prateleiras e capacidade.', keys: 'estante prateleira local guarda capacidade portaria armazenamento',
    allowed: settings, render: () => <StorageCard /> },
  { id: 'equipe', title: 'Equipe e permissões', desc: 'Porteiros, administradores, convites e revogações.', keys: 'equipe porteiro administrador sindico convite permissao revogar acesso',
    allowed: (t) => t.can('team') || settings(t), render: (t) => <>{t.can('team') && <TeamCard />}<OrgLinkCard /></> },
  { id: 'comunicacoes', title: 'Comunicações', desc: 'Canais de aviso, validade do QR e limite por unidade.', keys: 'notificacao aviso email whatsapp push canal qr validade moradores',
    allowed: settings, render: () => <><ChannelsCard /><RemindersCard /></> },
  { id: 'integracoes', title: 'Integrações e diagnóstico', desc: 'WhatsApp do condomínio, teste de envio, falhas e reenvio.', keys: 'whatsapp evolution conectar teste diagnostico falha reenviar fila',
    allowed: (t) => settings(t) && !!t.overview?.entitlements?.feature_whatsapp, render: (t) => <><WhatsAppCard />{t.link.role === 'admin' && <NotificationHealthCard />}</> },
  { id: 'comprovantes', title: 'Comprovantes', desc: 'Modelo do PDF de entrega, cores, textos e prévia.', keys: 'pdf comprovante layout rodape modelo recibo',
    allowed: settings, render: () => <ReceiptLayoutCard /> },
  { id: 'totens', title: 'Totens e dispositivos', desc: 'Pareamento, estado e revogação dos totens.', keys: 'totem tablet parear dispositivo revogar',
    allowed: (t) => settings(t) && !!t.overview?.entitlements?.feature_totem, render: () => <TotemCard /> },
  { id: 'dispositivos', title: 'Dispositivos e quiosque', desc: 'Tablets do condomínio em modo quiosque (Android gerenciado), políticas e manutenção.', keys: 'dispositivo quiosque kiosk tablet android mdm gerenciar politica manutencao wifi device owner',
    allowed: settings, render: () => <DevicesCard /> },
  { id: 'plano', title: 'Plano e assinatura', desc: 'Mês grátis, plano, limites e pagamentos.', keys: 'assinatura plano pagamento cobranca teste gratis fatura pix cartao',
    allowed: (t) => t.can('billing'), render: () => <AssinaturaPage embedded /> },
  { id: 'privacidade', title: 'Privacidade e LGPD', desc: 'Termo de ciência do morador: versões, publicação e registros de aceite.', keys: 'lgpd privacidade termo aceite dados pessoais consentimento ciencia',
    allowed: (t) => settings(t) || t.can('approve'), render: () => <PrivacyTermCard /> },
  { id: 'seguranca', title: 'Segurança e auditoria', desc: 'Histórico de ações e sessão deste aparelho.', keys: 'seguranca auditoria historico sessao sair log',
    allowed: (t) => t.link.role === 'admin', render: () => <SecurityCard /> },
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function ConfigPage({ section }: { section: string | null }) {
  const t = useTenant();
  const mods = MODULES.filter((m) => m.allowed(t));
  const current = section ? mods.find((m) => m.id === section) : null;
  const base = `/c/${t.tenant.slug}/configuracoes`;
  const go = (id: string | null) => navigate(id ? `${base}?m=${id}` : base);
  if (section && !current) {
    return <div className="space-y-4"><Alert tone="warning">Este módulo não existe ou não está disponível para o seu acesso.</Alert>
      <button className="underline text-sm" onClick={() => go(null)}>‹ Voltar para Configurações</button></div>;
  }
  return current ? <Module mod={current} mods={mods} go={go} /> : <Index mods={mods} go={go} />;
}

function Index({ mods, go }: { mods: Mod[]; go: (id: string | null) => void }) {
  const t = useTenant();
  const [q, setQ] = useState('');
  const shown = mods.filter((m) => !q || norm(`${m.title} ${m.desc} ${m.keys}`).includes(norm(q)));
  const ov = t.overview;
  return (
    <div className="space-y-5 max-w-5xl">
      <div><h1 className="text-2xl font-semibold">Configurações</h1><p className="text-sm text-muted">Escolha um módulo ou busque pelo que deseja ajustar.</p></div>
      {query('inicio') === '1' && (
        <Alert tone="success">
          Condomínio criado e mês grátis ativo. Enviamos o link do portal para o seu e-mail. Próximos passos: 1) identidade e logo; 2) locais de guarda; 3) unidades; 4) compartilhar o link do portal com os moradores; 5) registrar uma encomenda de teste.
        </Alert>
      )}
      {t.can('billing') && ov?.status === 'trialing' && (
        <p className="text-sm text-muted">Mês grátis até <strong>{dateTime(ov.trial_ends_at, t.tenant.timezone)}</strong>. Detalhes em <button className="underline" onClick={() => go('plano')}>Plano e assinatura</button>.</p>
      )}
      <label className="relative block max-w-md">
        <span className="sr-only">Buscar configuração</span>
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <Input className="pl-9" placeholder="Buscar por função (ex.: logo, estante, WhatsApp)" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {shown.length === 0 ? <Alert>Nenhum módulo encontrado para “{q}”.</Alert> : (
        <ul className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {shown.map((m) => (
            <li key={m.id}>
              <a href={`/c/${t.tenant.slug}/configuracoes?m=${m.id}`} onClick={(e) => { e.preventDefault(); go(m.id); }}
                className="flex h-full items-start justify-between gap-3 rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-24">
                <span><span className="block font-semibold">{m.title}</span><span className="block text-sm text-muted mt-1">{m.desc}</span></span>
                <ChevronRight className="w-4 h-4 mt-1 shrink-0 text-muted" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Module({ mod, mods, go }: { mod: Mod; mods: Mod[]; go: (id: string | null) => void }) {
  const t = useTenant();
  return (
    <div className="grid lg:grid-cols-[220px_minmax(0,1fr)] gap-6 items-start">
      <nav aria-label="Módulos de configuração" className="hidden lg:block lg:sticky lg:top-4">
        <ul className="space-y-0.5 text-sm">
          {mods.map((m) => (
            <li key={m.id}>
              <a href={`/c/${t.tenant.slug}/configuracoes?m=${m.id}`} onClick={(e) => { e.preventDefault(); go(m.id); }}
                aria-current={m.id === mod.id ? 'page' : undefined}
                className={`block rounded-lg px-3 py-2 ${m.id === mod.id ? 'bg-surface-2 font-semibold text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`}>{m.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 space-y-4 max-w-4xl">
        <nav aria-label="Trilha" className="text-sm">
          <a href={`/c/${t.tenant.slug}/configuracoes`} onClick={(e) => { e.preventDefault(); go(null); }} className="text-muted hover:text-text underline-offset-2 hover:underline">‹ Configurações</a>
        </nav>
        <div className="lg:hidden">
          <Select aria-label="Ir para outro módulo" value={mod.id} onChange={(e) => go(e.target.value)}>
            {mods.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </Select>
        </div>
        <div><h1 className="text-2xl font-semibold">{mod.title}</h1><p className="text-sm text-muted">{mod.desc}</p></div>
        {mod.render(t)}
      </div>
    </div>
  );
}
