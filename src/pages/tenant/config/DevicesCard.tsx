import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, Wrench, Power, Wifi, KeyRound, QrCode, Plus, Trash2 } from 'lucide-react';
import { useSensitive } from '../../../components/Reauth';
import { rpc, newKey } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { dateTime } from '../../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner, useAction, toast } from '../../../components/ui';
import { QRCodeDisplay } from '../../../components/VisualCodes';
import { COMMAND_LABEL, COMMAND_STATUS, DEVICE_LIMIT, DEVICE_LIMIT_MSG, LOCK_FEATURES, RESTRICTIONS, START_PATHS, STATE_LABEL, countsTowardLimit, generateRecoveryCodes, provisioningPayload } from '../../../lib/mdm';

/**
 * Configurações → Dispositivos e quiosque. Aparelhos institucionais com o app nativo
 * "Portaria Prime Kiosk" (Device Owner). Não confundir com "Instalar PWA" (etapa separada).
 * Ações sensíveis pedem a senha de novo (o banco exige login recente; MFA se cadastrado).
 */

const DEVICE_REAUTH = 'Ações que alteram ou liberam aparelhos gerenciados exigem confirmação recente da sua identidade.';

export function DevicesCard() {
  const t = useTenant();
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [policyEdit, setPolicyEdit] = useState<any>(null);
  const load = useCallback(async () => setData(await rpc('mdm_overview', { p_tenant: t.tenant.id })), [t.tenant.id]);
  useEffect(() => { load().catch((e) => toast.error(e.message)); }, [load]);
  if (!data) return <Spinner />;
  const used = countsTowardLimit(data.devices);
  const full = used >= DEVICE_LIMIT;
  return (
    <div className="space-y-4" data-tour="config-dispositivos">
      <Alert>
        <strong>Instalar o app (PWA) e gerenciar o aparelho são etapas diferentes.</strong> O PWA continua funcionando em qualquer celular.
        Aqui você gerencia tablets/celulares <em>do condomínio</em> com o aplicativo Android “Portaria Prime Kiosk”, que mantém a portaria
        aberta em modo quiosque. Celulares pessoais de moradores ou funcionários nunca são gerenciados. Sem câmera remota, microfone ou localização.
      </Alert>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Aparelhos</h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted" id="devices-limit">{used} de {DEVICE_LIMIT} aparelhos</span>
            <Button onClick={() => setAdding(true)} disabled={full} aria-describedby="devices-limit"><Plus className="w-4 h-4" /> Adicionar dispositivo</Button>
          </div>
        </div>
        {full && <Alert tone="warning">{DEVICE_LIMIT_MSG}</Alert>}
        {data.devices.length === 0 ? <p className="text-sm text-muted">Nenhum aparelho gerenciado. Cadastre um tablet da portaria para começar.</p> : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="text-left text-muted"><tr>
                <th className="py-2 pr-3">Nome</th><th className="pr-3">Situação</th><th className="pr-3">Modelo / Android</th>
                <th className="pr-3">Agente</th><th className="pr-3">Último contato</th><th className="pr-3">Bateria</th><th className="pr-3">Conformidade</th><th></th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {data.devices.map((d: any) => {
                  const [label, tone] = STATE_LABEL[d.state] || [d.state, 'neutral'];
                  return (
                    <tr key={d.id}>
                      <td className="py-2 pr-3"><span className="font-medium">{d.name}</span><span className="block text-xs text-muted">{d.concierge_name || '—'} · {START_PATHS[d.purpose === 'totem_equipe' ? 'totem-equipe' : d.purpose] || d.purpose}</span></td>
                      <td className="pr-3"><Badge tone={tone}>{label}</Badge></td>
                      <td className="pr-3">{d.model ? `${d.manufacturer || ''} ${d.model}` : '—'}<span className="block text-xs text-muted">{d.android_release ? `Android ${d.android_release} (API ${d.sdk_int})` : ''}</span></td>
                      <td className="pr-3">{d.agent_version || '—'}</td>
                      <td className="pr-3">{d.last_seen_at ? dateTime(d.last_seen_at, t.tenant.timezone) : 'Nunca'}</td>
                      <td className="pr-3">{d.battery_pct != null ? `${d.battery_pct}%${d.charging ? ' ⚡' : ''}` : '—'}</td>
                      <td className="pr-3">{d.state === 'desativado' ? <span className="text-muted">Fora do gerenciamento</span> : d.management === 'device_owner'
                        ? <Badge tone={d.compliant ? 'success' : 'warning'}>{d.compliant ? 'Device Owner · conforme' : 'Device Owner · divergente'}</Badge>
                        : <Badge tone={d.management === 'unmanaged' ? 'danger' : 'neutral'}>{d.management === 'unmanaged' ? 'Não gerenciado' : 'Aguardando'}</Badge>}</td>
                      <td><Button variant="ghost" onClick={() => setOpen(d.id)}>Detalhes</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <PoliciesCard data={data} onEdit={setPolicyEdit} reload={load} />
      <Card className="space-y-2">
        <h2 className="font-semibold">Matriz de capacidades</h2>
        <p className="text-sm text-muted">O agente exige Android 8.0 (API 26) ou superior. Compatibilidade real depende do fabricante e só vale após homologação física. O aparelho informa o que conseguiu aplicar; falhas aparecem nos detalhes. A câmera nunca é bloqueada (OCR, QR e foto de entrega dependem dela).</p>
        <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {RESTRICTIONS.map((r) => <li key={r.key}><span className="font-medium">{r.label}</span> <span className="text-muted">· Android API {r.minSdk}+{r.note ? ` · ${r.note}` : ''}</span></li>)}
          <li><span className="font-medium">Lock Task (quiosque)</span> <span className="text-muted">· Android 9 (API 28)+ para escolher recursos do sistema; Android 8 aplica Lock Task sem essa escolha</span></li>
          <li><span className="font-medium">Janela de atualização do sistema</span> <span className="text-muted">· API 26+; nunca adia indefinidamente</span></li>
          <li><span className="font-medium">Brilho fixo</span> <span className="text-muted">· API 28+</span></li>
          <li><span className="font-medium">Wi-Fi WPA3</span> <span className="text-muted">· API 30+ (WPA2 em todas)</span></li>
        </ul>
      </Card>
      {adding && <AddDevice data={data} onClose={() => setAdding(false)} onDone={async (id) => { setAdding(false); await load(); setOpen(id); }} />}
      {open && <DeviceDetail id={open} policies={data.policies} release={data.release} onClose={() => { setOpen(null); load(); }} />}
      {policyEdit && <PolicyEditor data={data} initial={policyEdit} onClose={() => setPolicyEdit(null)} onDone={async () => { setPolicyEdit(null); await load(); }} />}
    </div>
  );
}

function AddDevice({ data, onClose, onDone }: { data: any; onClose: () => void; onDone: (id: string) => void }) {
  const t = useTenant();
  const [name, setName] = useState(`Tablet ${data.devices.length + 1}`);
  const [purpose, setPurpose] = useState('portaria');
  const [concierge, setConcierge] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="Adicionar dispositivo" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(async () => {
        const r = await rpc('mdm_device_create', { p_tenant: t.tenant.id, p_name: name, p_purpose: purpose, p_concierge: concierge || null });
        onDone(r.device_id);
      }, 'Dispositivo cadastrado. Agora gere o QR de provisionamento.'); }}>
        <Field label="Nome do aparelho"><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} /></Field>
        <Field label="Finalidade"><Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value="portaria">Portaria (recebimento e entrega)</option><option value="totem_equipe">Totem da equipe</option><option value="painel">Painel do síndico</option>
        </Select></Field>
        {data.concierges.length > 1 && <Field label="Portaria"><Select value={concierge} onChange={(e) => setConcierge(e.target.value)}>
          <option value="">Principal</option>{data.concierges.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select></Field>}
        <p className="text-xs text-muted">O aparelho recebe a política padrão “Portaria (Single-App)”. Você pode trocar depois.</p>
        <Button type="submit" loading={busy}>Cadastrar</Button>
      </form>
    </Modal>
  );
}

function DeviceDetail({ id, policies, release, onClose }: { id: string; policies: any[]; release: any; onClose: () => void }) {
  const t = useTenant();
  const [d, setD] = useState<any>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const { busy, run } = useAction();
  const { guard, dialog } = useSensitive(DEVICE_REAUTH);
  const load = useCallback(async () => setD(await rpc('mdm_device_detail', { p_device: id })), [id]);
  useEffect(() => { load().catch((e) => toast.error(e.message)); }, [load]);
  const command = (action: string, params: any = {}, secret: string | null = null, ok?: string) => run(guard(async () => {
    await rpc('mdm_command_create', { p_device: id, p_action: action, p_params: params, p_idempotency_key: newKey(), p_secret: secret });
    toast.success(ok || 'Solicitado. “Solicitado” não é “executado”: acompanhe a confirmação do aparelho abaixo.');
    setPanel(null); await load();
  }));
  if (!d) return <Modal title="Dispositivo" onClose={onClose} wide><Spinner /></Modal>;
  const [label, tone] = STATE_LABEL[d.state] || [d.state, 'neutral'];
  const live = !['pendente_provisionamento', 'desativado', 'desativacao_pendente'].includes(d.state);
  const allVersions = policies.flatMap((p: any) => (p.versions || []).filter((v: any) => v.published_at).map((v: any) => ({ ...v, policy: p.name })));
  return (
    <Modal title={d.name} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><Badge tone={tone}>{label}</Badge>
          {d.management === 'device_owner' ? <Badge tone="success"><ShieldCheck className="w-3 h-3 inline" /> Device Owner</Badge> : d.management === 'unmanaged' ? <Badge tone="danger">Não gerenciado</Badge> : null}
          <span className="text-sm text-muted">{d.model ? `${d.manufacturer} ${d.model} · Android ${d.android_release}` : 'Ainda sem relatório do aparelho'}</span>
        </div>
        {d.state === 'falha' && <Alert tone="danger">{d.last_error || 'O aparelho relatou falha.'}</Alert>}
        {d.management === 'unmanaged' && <Alert tone="warning">O app está instalado sem Device Owner. Fullscreen ou fixação de tela não protegem o aparelho: provisione pelo QR na configuração inicial.</Alert>}

        <div className="flex flex-wrap gap-2">
          {['pendente_provisionamento', 'falha', 'provisionado'].includes(d.state) && <Button onClick={() => setPanel('enroll')}><QrCode className="w-4 h-4" /> Gerar QR de provisionamento</Button>}
          {live && <Button variant="secondary" loading={busy} onClick={() => command('sync_policy', {}, null, 'Sincronização solicitada.')}><RefreshCw className="w-4 h-4" /> Sincronizar</Button>}
          {live && d.state !== 'em_manutencao' && <Button variant="secondary" onClick={() => setPanel('maint')}><Wrench className="w-4 h-4" /> Abrir manutenção</Button>}
          {d.state === 'em_manutencao' && <Button variant="secondary" loading={busy} onClick={() => command('end_maintenance')}><Wrench className="w-4 h-4" /> Encerrar manutenção</Button>}
          {live && <Button variant="secondary" onClick={() => setPanel('wifi')}><Wifi className="w-4 h-4" /> Trocar Wi-Fi</Button>}
          {live && <Button variant="secondary" onClick={() => setPanel('policy')}>Atribuir política</Button>}
          {d.state !== 'desativado' && <Button variant="secondary" onClick={() => setPanel('recovery')}><KeyRound className="w-4 h-4" /> Códigos de recuperação</Button>}
          {live && d.management === 'device_owner' && <Button variant="ghost" onClick={() => setPanel('reboot')}><Power className="w-4 h-4" /> Reiniciar</Button>}
          {d.state !== 'desativado' && d.state !== 'pendente_provisionamento' && <Button variant="ghost" onClick={() => setPanel('deactivate')}><Trash2 className="w-4 h-4" /> Desativar gerenciamento</Button>}
        </div>

        {panel === 'enroll' && <EnrollPanel id={id} release={release} guard={guard} />}
        {panel === 'maint' && <MaintPanel max={d.desired?.config?.maintenance_max_minutes || 30} busy={busy} onSubmit={(p) => command('start_maintenance', p)} />}
        {panel === 'wifi' && <WifiPanel busy={busy} onSubmit={(p, s) => command('wifi_apply', p, s)} />}
        {panel === 'policy' && <AssignPanel versions={allVersions} current={d.desired?.id} onSubmit={(v) => run(guard(async () => {
          await rpc('mdm_assign', { p_devices: [id], p_version: v }); toast.success('Política atribuída. O aparelho aplica na próxima sincronização.'); setPanel(null); await load();
        }))} busy={busy} />}
        {panel === 'recovery' && <RecoveryPanel id={id} recovery={d.recovery} guard={guard} name={d.name} tenant={t.tenant.name} onDone={load} />}
        {panel === 'reboot' && <Confirm text="O aparelho reinicia e a operação da portaria fica interrompida por 1 a 3 minutos. Ele volta sozinho ao Portaria Prime (pode exigir desbloqueio se houver senha de tela)." label="Solicitar reinício" busy={busy} onYes={() => command('reboot')} />}
        {panel === 'deactivate' && <DeactivatePanel d={d} busy={busy} onRequest={() => command('deactivate', {}, null, 'Desativação solicitada. O aparelho continua gerenciado até confirmar.')}
          onConfirmLocal={(s) => run(guard(async () => { await rpc('mdm_deactivation_confirm_local', { p_device: id, p_statement: s }); toast.success('Desativação registrada.'); setPanel(null); await load(); }))} />}

        <section className="grid md:grid-cols-2 gap-3 text-sm">
          <Card className="space-y-1"><h3 className="font-semibold">Política desejada</h3>
            {d.desired ? <PolicySummary v={d.desired} /> : <p className="text-muted">Nenhuma</p>}</Card>
          <Card className="space-y-1"><h3 className="font-semibold">Política aplicada (confirmada pelo aparelho)</h3>
            {d.applied ? <PolicySummary v={d.applied} /> : <p className="text-muted">Ainda não confirmada</p>}
            {(d.report?.failed_restrictions || []).length > 0 && <Alert tone="warning">Não aplicadas neste aparelho: {d.report.failed_restrictions.join(', ')}</Alert>}</Card>
        </section>
        {(d.report?.apps || []).length > 0 && <p className="text-sm"><strong>Apps do catálogo instalados:</strong> {d.report.apps.map((a: any) => `${a.package_name} (${a.version_code})`).join(', ')}</p>}
        <section className="space-y-1"><h3 className="font-semibold text-sm">Comandos</h3>
          {d.commands.length === 0 ? <p className="text-sm text-muted">Nenhum.</p> : <ul className="text-sm divide-y divide-line">
            {d.commands.map((c: any) => <li key={c.id} className="py-1.5 flex flex-wrap justify-between gap-2">
              <span>#{c.seq} {COMMAND_LABEL[c.action] || c.action}{c.params?.ssid ? ` · ${c.params.ssid}` : ''}{c.params?.minutes ? ` · ${c.params.minutes} min` : ''}</span>
              <span className="text-muted">{COMMAND_STATUS[c.status] || c.status}{c.detail ? ` — ${c.detail}` : ''} · {dateTime(c.updated_at, t.tenant.timezone)}</span></li>)}
          </ul>}
        </section>
        <section className="space-y-1"><h3 className="font-semibold text-sm">Eventos</h3>
          <ul className="text-xs divide-y divide-line max-h-56 overflow-y-auto">
            {d.events.map((e: any, i: number) => <li key={i} className="py-1 flex justify-between gap-2"><span>{e.event} <span className="text-muted">({e.source})</span></span><span className="text-muted">{dateTime(e.created_at, t.tenant.timezone)}</span></li>)}
          </ul>
        </section>
      </div>
      {dialog}
    </Modal>
  );
}

function PolicySummary({ v }: { v: any }) {
  const c = v.config;
  return <ul className="text-muted space-y-0.5">
    <li><span className="text-text">{v.policy} v{v.version}</span> · {c.mode === 'single_app' ? 'Single-App' : `Multi-App (${c.apps.length} apps)`}</li>
    <li>Tela inicial: {START_PATHS[c.start_path]}</li>
    <li>Restrições: {c.restrictions.length} · Barra de status {c.status_bar_disabled ? 'bloqueada' : 'liberada'}</li>
    <li>Atualização do sistema: {c.system_update.type === 'windowed' ? `janela ${Math.floor(c.system_update.start_min / 60)}h–${Math.floor(c.system_update.end_min / 60)}h` : 'automática'}</li>
  </ul>;
}

function EnrollPanel({ id, release, guard }: { id: string; release: any; guard: (f: () => Promise<void>) => () => Promise<void> }) {
  const [enr, setEnr] = useState<any>(null);
  const [wifi, setWifi] = useState({ ssid: '', password: '' });
  const { busy, run } = useAction();
  const payload = enr && release ? provisioningPayload({ apkUrl: release.apk_url, signatureChecksum: release.signature_checksum, token: enr.token,
    apiBase: location.origin, wifi: wifi.ssid ? { ssid: wifi.ssid, password: wifi.password, security: wifi.password ? 'WPA' : 'NONE' } : null }) : null;
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">Provisionamento (Device Owner)</h3>
      <ol className="list-decimal pl-5 text-sm space-y-1">
        <li>Use só aparelho <strong>do condomínio</strong>. O provisionamento exige aparelho <strong>restaurado de fábrica</strong>: tudo que estiver nele é apagado. Antes, confira backup, remova contas Google pessoais e anote senhas de bloqueio.</li>
        <li>Se o aparelho já for gerenciado por outra empresa (outro MDM), não continue: peça a liberação a quem gerencia.</li>
        <li>Na tela de boas-vindas, toque 6 vezes no mesmo ponto para abrir o leitor de QR e leia o código abaixo.</li>
        <li>O Android baixa o Portaria Prime Kiosk (HTTPS, assinatura conferida) e o torna proprietário do aparelho. Ao final, o app abre a portaria deste condomínio.</li>
      </ol>
      {!release && <Alert tone="warning">Ainda não há versão do agente publicada pela plataforma (APK assinado + checksum). O QR fica disponível quando a versão for publicada.</Alert>}
      <div className="grid sm:grid-cols-2 gap-2">
        <Field label="Wi-Fi para o provisionamento (opcional)"><Input value={wifi.ssid} onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })} maxLength={32} placeholder="Nome da rede" /></Field>
        <Field label="Senha do Wi-Fi" hint="Fica só no QR exibido; não é gravada."><Input type="password" value={wifi.password} onChange={(e) => setWifi({ ...wifi, password: e.target.value })} maxLength={63} /></Field>
      </div>
      {!enr ? <Button loading={busy} disabled={!release} onClick={() => run(guard(async () => setEnr(await rpc('mdm_enrollment_create', { p_device: id, p_minutes: 60 }))))}>Gerar código de uso único (60 min)</Button> : (
        <div className="space-y-2">
          {payload && <div className="bg-white p-3 rounded-xl inline-block"><QRCodeDisplay value={payload} size={300} /></div>}
          <p className="text-sm">Código de inscrição (uso único, expira {new Date(enr.expires_at).toLocaleTimeString('pt-BR')}): <span className="font-mono">{enr.token}</span></p>
          <p className="text-xs text-muted">Se o app já estiver instalado como Device Owner (laboratório), digite esse código na tela de inscrição do app. Gerar outro código invalida este.</p>
        </div>
      )}
    </Card>
  );
}

function MaintPanel({ max, busy, onSubmit }: { max: number; busy: boolean; onSubmit: (p: any) => void }) {
  const [p, setP] = useState({ minutes: Math.min(15, max), scope: 'settings', reason: '' });
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold">Manutenção supervisionada</h3>
      <p className="text-sm text-muted">Suspende o quiosque e as restrições temporariamente, mantendo o gerenciamento. Termina sozinha no prazo (contado também no aparelho, mesmo offline) e reaplica a política. O pedido expira em 10 minutos se o aparelho não buscar.</p>
      <div className="grid sm:grid-cols-3 gap-2">
        <Field label="Duração (min)"><Input type="number" min={5} max={max} value={p.minutes} onChange={(e) => setP({ ...p, minutes: Number(e.target.value) })} /></Field>
        <Field label="Escopo"><Select value={p.scope} onChange={(e) => setP({ ...p, scope: e.target.value })}>
          <option value="settings">Configurações do Android</option><option value="wifi">Somente Wi-Fi</option><option value="apps">Instalar/atualizar apps</option></Select></Field>
        <Field label="Motivo"><Input value={p.reason} onChange={(e) => setP({ ...p, reason: e.target.value })} minLength={3} maxLength={200} /></Field>
      </div>
      <Button loading={busy} disabled={p.reason.trim().length < 3} onClick={() => onSubmit(p)}>Autorizar manutenção</Button>
    </Card>
  );
}

function WifiPanel({ busy, onSubmit }: { busy: boolean; onSubmit: (p: any, secret: string | null) => void }) {
  const [p, setP] = useState({ ssid: '', security: 'wpa2', password: '' });
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold">Trocar Wi-Fi em duas etapas</h3>
      <p className="text-sm text-muted">1) O aparelho adiciona a nova rede e testa a conexão com o Portaria Prime. 2) Só se der certo remove a anterior; se falhar, volta para a anterior. A senha é apagada do servidor após a confirmação e nunca aparece no painel.</p>
      <div className="grid sm:grid-cols-3 gap-2">
        <Field label="Rede (SSID)"><Input value={p.ssid} onChange={(e) => setP({ ...p, ssid: e.target.value })} maxLength={32} /></Field>
        <Field label="Segurança"><Select value={p.security} onChange={(e) => setP({ ...p, security: e.target.value })}><option value="wpa2">WPA2</option><option value="wpa3">WPA3</option><option value="open">Aberta</option></Select></Field>
        {p.security !== 'open' && <Field label="Senha"><Input type="password" value={p.password} onChange={(e) => setP({ ...p, password: e.target.value })} maxLength={63} /></Field>}
      </div>
      <Button loading={busy} disabled={!p.ssid || (p.security !== 'open' && p.password.length < 8)} onClick={() => onSubmit({ ssid: p.ssid, security: p.security }, p.security === 'open' ? null : p.password)}>Enviar para o aparelho</Button>
    </Card>
  );
}

function AssignPanel({ versions, current, onSubmit, busy }: { versions: any[]; current?: string; onSubmit: (v: string) => void; busy: boolean }) {
  const [v, setV] = useState(current || versions[0]?.id || '');
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold">Atribuir política publicada</h3>
      <Select value={v} onChange={(e) => setV(e.target.value)}>{versions.map((x) => <option key={x.id} value={x.id}>{x.policy} v{x.version}</option>)}</Select>
      <Button loading={busy} disabled={!v || v === current} onClick={() => onSubmit(v)}>Atribuir</Button>
    </Card>
  );
}

function RecoveryPanel({ id, recovery, guard, name, tenant, onDone }: { id: string; recovery: any; guard: (f: () => Promise<void>) => () => Promise<void>; name: string; tenant: string; onDone: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const { busy, run } = useAction();
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold">Recuperação offline</h3>
      <p className="text-sm text-muted">Códigos de uso único para abrir manutenção no próprio aparelho quando não houver internet (até 15 min, 5 tentativas erradas bloqueiam por 15 min). O aparelho guarda só o hash. Imprima e guarde em local seguro, fora da portaria. Gerar novos invalida os anteriores.</p>
      <p className="text-sm">Lote atual: {recovery.version ? `v${recovery.version}, ${recovery.remaining} de ${recovery.total} disponíveis` : 'nenhum'}</p>
      {codes ? (
        <div className="space-y-2">
          <Alert tone="warning">Estes códigos não serão exibidos de novo.</Alert>
          <ol className="grid grid-cols-2 gap-1 font-mono text-sm list-decimal pl-6">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
          <Button variant="secondary" onClick={() => {
            const w = window.open('', '_blank', 'noopener');
            if (!w) return;
            w.document.title = 'Códigos de recuperação';
            const pre = w.document.createElement('pre');
            pre.textContent = `${tenant} — ${name}\nCódigos de recuperação (uso único)\n\n${codes.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
            w.document.body.appendChild(pre); w.print();
          }}>Imprimir</Button>
        </div>
      ) : <Button loading={busy} onClick={() => run(guard(async () => {
        const { codes: c, stored } = await generateRecoveryCodes(10);
        await rpc('mdm_recovery_set', { p_device: id, p_codes: stored });
        setCodes(c); onDone();
      }))}>Gerar 10 códigos</Button>}
    </Card>
  );
}

function DeactivatePanel({ d, busy, onRequest, onConfirmLocal }: { d: any; busy: boolean; onRequest: () => void; onConfirmLocal: (s: string) => void }) {
  const [s, setS] = useState('');
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold">Desativação supervisionada</h3>
      <p className="text-sm text-muted">O aparelho remove o quiosque e as restrições e libera o Device Owner. Até a confirmação dele, o registro fica “desativação pendente” e nada é apagado. Em alguns modelos/versões o Android pode exigir restauração de fábrica para voltar ao uso comum.</p>
      {d.state !== 'desativacao_pendente' ? <Button loading={busy} onClick={onRequest}>Solicitar desativação</Button> : (
        <div className="space-y-2">
          <Alert>Aguardando confirmação do aparelho. Se ele foi perdido, quebrou ou foi restaurado manualmente, registre como foi liberado:</Alert>
          <Field label="Como o aparelho foi liberado"><Input value={s} onChange={(e) => setS(e.target.value)} maxLength={300} /></Field>
          <Button variant="secondary" loading={busy} disabled={s.trim().length < 10} onClick={() => onConfirmLocal(s)}>Registrar liberação local</Button>
        </div>
      )}
    </Card>
  );
}

function Confirm({ text, label, busy, onYes }: { text: string; label: string; busy: boolean; onYes: () => void }) {
  return <Card className="space-y-2"><Alert tone="warning">{text}</Alert><Button loading={busy} onClick={onYes}>{label}</Button></Card>;
}

function PoliciesCard({ data, onEdit, reload }: { data: any; onEdit: (p: any) => void; reload: () => Promise<void> }) {
  const { busy, run } = useAction();
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Políticas</h2>
        <Button variant="secondary" onClick={() => onEdit({ name: '', config: null })}><Plus className="w-4 h-4" /> Nova política</Button>
      </div>
      <p className="text-sm text-muted">Cada alteração cria uma versão. Publique, aplique em um aparelho piloto e só depois em lote.</p>
      <ul className="divide-y divide-line text-sm">
        {data.policies.map((p: any) => <li key={p.id} className="py-2 space-y-1">
          <div className="flex justify-between gap-2"><span className="font-medium">{p.name}</span>
            <Button variant="ghost" onClick={() => onEdit({ id: p.id, name: p.name, config: p.versions[0]?.config })}>Nova versão</Button></div>
          <ul className="text-muted space-y-0.5">{p.versions.map((v: any) => <li key={v.id} className="flex flex-wrap gap-2 items-center">
            v{v.version} · {v.config.mode === 'single_app' ? 'Single-App' : 'Multi-App'} · {v.published_at ? `publicada · ${v.devices} aparelho(s), ${v.applied} aplicado(s)` : 'rascunho'}
            {!v.published_at && <Button variant="ghost" loading={busy} onClick={() => run(async () => { await rpc('mdm_policy_publish', { p_version: v.id }); await reload(); }, 'Versão publicada.')}>Publicar</Button>}
          </li>)}</ul>
        </li>)}
      </ul>
    </Card>
  );
}

function PolicyEditor({ data, initial, onClose, onDone }: { data: any; initial: any; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const base = initial.config || data.policies[0]?.versions[0]?.config;
  const [name, setName] = useState(initial.name);
  const [c, setC] = useState<any>({ ...base });
  const { busy, run } = useAction();
  const toggle = (k: string, v: string) => setC({ ...c, [k]: c[k].includes(v) ? c[k].filter((x: string) => x !== v) : [...c[k], v] });
  const single = c.mode === 'single_app';
  return (
    <Modal title={initial.id ? `Nova versão: ${initial.name}` : 'Nova política'} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => {
        await rpc('mdm_policy_save', { p_tenant: t.tenant.id, p_policy: initial.id || null, p_name: name, p_config: c }); onDone();
      }, 'Versão salva como rascunho. Publique para atribuir.'); }}>
        {!initial.id && <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} /></Field>}
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Modo"><Select value={c.mode} onChange={(e) => setC({ ...c, mode: e.target.value, apps: e.target.value === 'single_app' ? [] : c.apps,
            lock_task_features: e.target.value === 'single_app' ? c.lock_task_features.filter((f: string) => !['home', 'overview', 'notifications'].includes(f)) : c.lock_task_features })}>
            <option value="single_app">Single-App (somente Portaria Prime)</option><option value="multi_app">Multi-App (apps autorizados)</option></Select></Field>
          <Field label="Tela inicial"><Select value={c.start_path} onChange={(e) => setC({ ...c, start_path: e.target.value })}>
            {Object.entries(START_PATHS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        </div>
        {!single && <fieldset className="space-y-1"><legend className="font-medium text-sm">Apps autorizados (catálogo)</legend>
          {data.catalog.map((a: any) => <label key={a.package_name} className="flex gap-2 text-sm"><input type="checkbox" checked={c.apps.includes(a.package_name)} onChange={() => toggle('apps', a.package_name)} />
            {a.label} <span className="text-muted font-mono text-xs">{a.package_name}</span></label>)}
          <p className="text-xs text-muted">Navegador completo não está no catálogo: liberar Chrome abriria navegação externa irrestrita.</p></fieldset>}
        <fieldset className="space-y-1"><legend className="font-medium text-sm">Recursos do sistema no quiosque</legend>
          {LOCK_FEATURES.filter((f) => !single || f.singleApp).map((f) => <label key={f.key} className="flex gap-2 text-sm"><input type="checkbox" checked={c.lock_task_features.includes(f.key)} onChange={() => toggle('lock_task_features', f.key)} />{f.label}</label>)}
        </fieldset>
        <fieldset className="space-y-1"><legend className="font-medium text-sm">Restrições</legend>
          {RESTRICTIONS.map((r) => <label key={r.key} className="flex gap-2 text-sm"><input type="checkbox" checked={c.restrictions.includes(r.key)} onChange={() => toggle('restrictions', r.key)} />{r.label}{r.note && <span className="text-muted text-xs">({r.note})</span>}</label>)}
        </fieldset>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Orientação"><Select value={c.orientation} onChange={(e) => setC({ ...c, orientation: e.target.value })}><option value="auto">Automática</option><option value="portrait">Retrato</option><option value="landscape">Paisagem</option></Select></Field>
          <Field label="Manutenção máxima (min)"><Input type="number" min={5} max={240} value={c.maintenance_max_minutes} onChange={(e) => setC({ ...c, maintenance_max_minutes: Number(e.target.value) })} /></Field>
          <Field label="Sincronização (s)" hint="Maior economiza bateria."><Input type="number" min={60} max={3600} value={c.sync_interval_seconds} onChange={(e) => setC({ ...c, sync_interval_seconds: Number(e.target.value) })} /></Field>
        </div>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={c.status_bar_disabled} onChange={(e) => setC({ ...c, status_bar_disabled: e.target.checked })} />Bloquear barra de status (avisos internos do Portaria Prime continuam)</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={c.keep_screen_on} onChange={(e) => setC({ ...c, keep_screen_on: e.target.checked })} />Tela ligada enquanto a portaria estiver aberta</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={c.stay_on_plugged} onChange={(e) => setC({ ...c, stay_on_plugged: e.target.checked })} />Nunca suspender quando ligado na tomada (atenção a aquecimento)</label>
        <Field label="Atualização do sistema"><Select value={c.system_update.type === 'windowed' ? 'w' : 'a'} onChange={(e) => setC({ ...c, system_update: e.target.value === 'w' ? { type: 'windowed', start_min: 120, end_min: 300 } : { type: 'automatic' } })}>
          <option value="a">Automática</option><option value="w">Janela das 2h às 5h</option></Select></Field>
        <Button type="submit" loading={busy}>Salvar versão</Button>
      </form>
    </Modal>
  );
}
