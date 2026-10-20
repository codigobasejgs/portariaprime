import React, { useState } from 'react';
import { Card, Input } from '../components/ui';
import { useTenant } from '../lib/tenant';
import { usePwaInstall } from '../hooks/usePwaInstall';

const topics = [
  ['Receber encomendas', 'Na Portaria, escolha Receber. Fotografe a etiqueta ou digite os dados. Confira a unidade, destinatário e rastreio mesmo quando usar OCR. Só considere registrado após a confirmação do servidor.'],
  ['Armazenar e movimentar', 'O local automático respeita capacidade e ocupação. Se estiver lotado, escolha outro local ou peça uma área de contingência. Use Mover para registrar a alteração no histórico.'],
  ['Avisos ao morador', 'Recebimentos confirmados geram avisos na fila do servidor. Aceito pelo provedor não significa entregue. Falhas de canal não desfazem o recebimento. WhatsApp e OCR dependem do plano e das franquias.'],
  ['Entregar com QR', 'Escolha Entregar e leia o QR do morador. Confira quem retira e colete assinatura. QR expirado deve ser renovado pelo morador. Sem QR, use Buscar e Entregar sem QR, com justificativa.'],
  ['Comprovantes', 'O comprovante aparece após a retirada confirmada. Abra para imprimir ou salvar em PDF. As provas têm acesso restrito. Reabra o comprovante caso o link temporário da imagem expire.'],
  ['Unidades e moradores', 'Administradores cadastram unidades manualmente ou importam CSV com prévia. Moradores entram por convite enviado ao e-mail correto. Saber bloco e unidade não concede acesso. Revogue vínculos quando alguém se mudar.'],
  ['Personalizar o condomínio', 'Em Configurações, escolha nome, logo PNG/JPEG/WebP, cores e tema. Confira a prévia e salve. A marca do condomínio não altera a conta recebedora nem a assinatura da plataforma.'],
  ['Teste e assinatura', 'Todo condomínio novo elegível recebe um mês de calendário sem cartão. A data exata fica em Assinatura. Depois do teste, o pagamento é por link InfinitePay. Não há débito automático. Cancelar interrompe cobranças futuras, preservando o período concedido.'],
  ['Sem internet', 'Não confirme recebimentos, pagamentos ou retiradas offline. Aguarde a conexão e verifique se o servidor confirmou a operação. Não há sincronização offline de provas.'],
  ['Câmera e notificações', 'Permissões negadas podem ser alteradas no navegador. Sem câmera, envie uma imagem ou digite os dados. Push depende do dispositivo, navegador e configuração; avisos internos continuam no sistema.'],
];

export default function HelpPage() {
  const t = useTenant();
  const [query, setQuery] = useState('');
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  const [step, setStep] = useState<number | null>(null);
  const tour = t.link.role === 'morador' ? ['Veja suas encomendas em Minhas encomendas.', 'Gere o QR apenas quando for retirar.', 'Consulte comprovantes no histórico.']
    : ['Cadastre as unidades e convide as pessoas autorizadas.', 'Receba e confira o destino antes de salvar.', 'Entregue com QR ou justificativa, assinatura e confirmação do servidor.'];
  return <section className="space-y-4"><h1 className="text-2xl font-semibold">Ajuda</h1>
    <Input aria-label="Pesquisar ajuda" placeholder="Pesquisar orientação" value={query} onChange={e => setQuery(e.target.value)} />
    <Card><h2 className="font-semibold">Instalar no dispositivo</h2>
      {isInstalled ? <p>Aplicativo instalado neste dispositivo.</p> : isInstallable ? <button className="underline min-h-11" onClick={promptInstall}>Instalar aplicativo</button> : <p>No iPhone: Compartilhar, Adicionar à Tela de Início. Em outros navegadores, procure Instalar no menu. HTTPS e navegador compatível são necessários.</p>}
    </Card>
    <Card><h2 className="font-semibold">Guia rápido</h2>{step === null ? <button className="underline min-h-11" onClick={() => setStep(0)}>Iniciar ou recomeçar guia</button> : <div data-tour-step={step}>
      <p>{step + 1}/{tour.length}: {tour[step]}</p><button className="underline min-h-11 mr-4" onClick={() => setStep(step + 1 < tour.length ? step + 1 : null)}>Continuar</button><button className="underline min-h-11" onClick={() => setStep(null)}>Pular</button>
    </div>}</Card>
    {topics.filter(topic => topic.join(' ').toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'))).map(([title, text]) => <details key={title} className="rounded-xl border border-line bg-surface p-4"><summary className="cursor-pointer font-semibold">{title}</summary><p className="mt-3 text-sm text-muted">{text}</p></details>)}
  </section>;
}
