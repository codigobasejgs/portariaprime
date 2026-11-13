/**
 * Capturas reais do sistema (tenant fictício, stack local isolada), geradas por
 * `scripts/capture-screens.mjs` em public/screens. Usadas pela landing e pela ajuda.
 * Detalhes de rota/viewport/commit em docs/SCREENSHOTS_MANIFEST.md.
 */
export interface Screen { file: string; title: string; caption: string; width: number; height: number }

export const SCREENS = {
  painel: { file: '/screens/painel-desktop.webp', title: 'Visão geral do síndico', caption: 'Aguardando agora, acima do prazo, ocupação e o que precisa de atenção.', width: 1440, height: 900 },
  recebimento: { file: '/screens/recebimento-desktop.webp', title: 'Recebimento na portaria', caption: 'Passo a passo: unidade, destinatário, rastreio e local conferidos antes de salvar.', width: 1440, height: 900 },
  armazenamento: { file: '/screens/armazenamento-desktop.webp', title: 'Ocupação dos locais', caption: 'Capacidade e ocupação de cada estante ou sala.', width: 1440, height: 900 },
  portariaMobile: { file: '/screens/portaria-mobile.webp', title: 'Portaria no celular', caption: 'Receber encomenda e Entregar ao morador em destaque; embaixo, o que aguarda retirada.', width: 390, height: 844 },
  morador: { file: '/screens/morador-mobile.webp', title: 'App do morador', caption: 'Quantas encomendas aguardam retirada e o botão do QR em cada uma.', width: 390, height: 844 },
  comprovante: { file: '/screens/comprovante-desktop.webp', title: 'Comprovante de retirada', caption: 'Protocolo, quem retirou, assinatura e foto do item.', width: 1440, height: 900 },
  marcaA: { file: '/screens/marca-a-desktop.webp', title: 'Condomínio A', caption: 'Logo e cores próprias do condomínio.', width: 1440, height: 900 },
  marcaB: { file: '/screens/marca-b-desktop.webp', title: 'Condomínio B', caption: 'Outro condomínio, outra identidade, dados separados.', width: 1440, height: 900 },
  moradorQr: { file: '/screens/morador-qr-mobile.webp', title: 'QR de retirada', caption: 'Código de uso único com unidade e encomenda identificadas (desfocado nesta imagem).', width: 390, height: 844 },
  // Gerada por scripts/capture-demo-screens.mjs a partir de /demonstracao (dados fictícios).
  envios: { file: '/screens/envios-desktop.webp', title: 'Mensagens enviadas', caption: 'Cada WhatsApp e e-mail com data, unidade, morador, destino e situação; filtros e exportação em CSV, Excel e PDF.', width: 1440, height: 900 },
  assinatura: { file: '/screens/assinatura-desktop.webp', title: 'Mês grátis e plano', caption: 'Início e fim do teste, plano escolhido e valor depois do teste.', width: 1440, height: 900 },
  // Modo Portaria Exclusiva: capturas reais do app Android gerenciado em EMULADOR Android 14 (tests/evidence/emu-*),
  // condomínio de laboratório fictício; código de verificação desfocado. Não são fotos de aparelho físico.
  quiosqueRecebimento: { file: '/screens/quiosque-recebimento.webp', title: 'Recebimento no terminal Android', caption: 'Demonstração em emulador: encomenda registrada dentro do app dedicado.', width: 1280, height: 800 },
  quiosqueComprovante: { file: '/screens/quiosque-comprovante.webp', title: 'Comprovante no terminal Android', caption: 'Demonstração em emulador: retirada confirmada com protocolo.', width: 1280, height: 800 },
  quiosqueManutencao: { file: '/screens/quiosque-manutencao.webp', title: 'Manutenção com prazo', caption: 'Demonstração em emulador: liberação temporária que volta sozinha ao terminal.', width: 1280, height: 800 },
} satisfies Record<string, Screen>;

export type ScreenKey = keyof typeof SCREENS;

/** Variante de 720 px gerada junto (só para capturas desktop). */
export const srcSet = (s: Screen) => (s.width > 720 ? `${s.file.replace('.webp', '-720.webp')} 720w, ${s.file} ${s.width}w` : undefined);
