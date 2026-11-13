/**
 * Central de ajuda: artigos em linguagem simples. Cada artigo é ligado a uma área (“Ajuda desta tela”)
 * e, quando existe, a um tour. Recursos de superadmin não aparecem aqui.
 * Revisão: v1, 21/10/2026.
 */
import type { Role } from './tours';
import type { ScreenKey } from './screens';

export interface Article {
  slug: string; title: string; category: string; roles: Role[]; areas: string[]; tour?: string; screen?: ScreenKey;
  forWho: string; when: string; before: string[]; steps: string[]; result: string; confirm: string;
  problems: [string, string][]; next: string[]; keywords?: string;
}

export const CATEGORIES = ['Minhas encomendas', 'Acesso e cadastro', 'Primeiros passos', 'Síndico', 'Equipe e portaria', 'Morador', 'Totem', 'Encomendas e retiradas',
  'Notificações e aplicativo', 'Personalização', 'Plano, teste e cobrança', 'Segurança e permissões', 'Solução de problemas', 'Suporte'];

const ALL: Role[] = ['admin', 'porteiro', 'morador'];
const STAFF: Role[] = ['admin', 'porteiro'];

export const ARTICLES: Article[] = [
  // ---- Morador (conteúdo próprio, curto; sem temas de equipe ou cobrança) ----
  {
    slug: 'morador-chegou', title: 'Como saber se chegou encomenda', category: 'Minhas encomendas', roles: ['morador'], areas: ['inicio'], tour: 'morador', keywords: 'chegou encomenda pacote aviso inicio',
    forWho: 'Morador.', when: 'Para ver o que está na portaria.',
    before: [],
    steps: ['Abra o Início.', 'O topo mostra quantas encomendas aguardam retirada.', 'Cada cartão traz transportadora, número (#) e quando chegou.'],
    result: 'Você vê tudo o que aguarda retirada, das mais antigas para as mais novas.', confirm: '“Nenhuma encomenda aguardando retirada” significa que não há nada pendente.',
    problems: [['Aparece erro ao carregar', 'Isso não significa que não há encomendas. Toque em “Tentar novamente” ou confira a conexão.']],
    next: ['morador-retirar', 'morador-notificacoes'],
  },
  {
    slug: 'morador-retirar', title: 'Como apresentar o QR na portaria', category: 'Minhas encomendas', roles: ['morador'], areas: ['encomenda'], tour: 'morador', keywords: 'qr codigo retirar retirada portaria',
    forWho: 'Morador.', when: 'Na hora de buscar a encomenda.',
    before: [],
    steps: ['No Início, toque em “Mostrar QR de retirada” na encomenda certa.', 'Confira a unidade e o número da encomenda no topo da tela.', 'Mostre o código à portaria. A equipe confirma a entrega com sua assinatura.'],
    result: 'A encomenda passa para o Histórico, com o comprovante.', confirm: 'O cartão some do Início e aparece “Retirada” no Histórico.',
    problems: [['Estou sem celular ou sem internet', 'A portaria pode localizar a encomenda pela sua unidade e conferir sua identidade.']],
    next: ['morador-qr-venceu', 'morador-comprovante'],
  },
  {
    slug: 'morador-qr-venceu', title: 'O QR venceu', category: 'Minhas encomendas', roles: ['morador'], areas: [], keywords: 'qr venceu expirou vencido invalido codigo',
    forWho: 'Morador.', when: 'Quando a tela mostra “Este código venceu” ou a portaria não aceita o código.',
    before: [],
    steps: ['Toque em “Gerar novo código”. O código anterior deixa de valer.', 'Se a tela disser que a encomenda não está mais aguardando, ela pode ter sido retirada por outra pessoa da unidade: confira o Histórico.'],
    result: 'Um código novo, válido para uma única retirada.', confirm: 'A tela mostra a nova validade.', problems: [], next: ['morador-outra-pessoa'],
  },
  {
    slug: 'morador-comprovante', title: 'Onde consultar o comprovante', category: 'Minhas encomendas', roles: ['morador'], areas: ['historico'], keywords: 'comprovante pdf recibo protocolo baixar',
    forWho: 'Morador.', when: 'Depois de uma retirada.',
    before: [],
    steps: ['Abra Histórico e toque na encomenda.', 'Toque em “Ver comprovante” para abrir o PDF.', 'Se aparecer “em processamento”, volte em instantes.'],
    result: 'PDF com protocolo, quem retirou, data, assinatura e foto do item.', confirm: 'O protocolo começa com PP-.',
    problems: [['Não aparece comprovante', 'Ele só fica disponível para quem já estava cadastrado na unidade no dia da retirada.'], ['O PDF não abriu', 'Use o link “Baixar o PDF” que aparece logo abaixo.']],
    next: ['morador-outra-pessoa'],
  },
  {
    slug: 'morador-outra-pessoa', title: 'Outra pessoa da unidade retirou', category: 'Minhas encomendas', roles: ['morador'], areas: [], keywords: 'outra pessoa retirou familiar quem retirou',
    forWho: 'Morador.', when: 'Uma encomenda sumiu do Início.',
    before: [],
    steps: ['Abra Histórico e toque na encomenda.', 'Veja “Retirada por” e a data.', 'Abra o comprovante para ver assinatura e foto do item.'],
    result: 'Você confirma quem retirou e quando.', confirm: 'A situação aparece como “Retirada”.', problems: [['Não reconheço a retirada', 'Fale com a portaria ou a administração informando o protocolo.']], next: [],
  },
  {
    slug: 'morador-notificacoes', title: 'Ativar notificações e instalar o app', category: 'Notificações e aplicativo', roles: ['morador'], areas: ['notificacoes', 'conta'], tour: 'morador', keywords: 'notificacao aviso push instalar app iphone android whatsapp email',
    forWho: 'Morador.', when: 'Para ser avisado quando chegar algo.',
    before: [],
    steps: ['Abra Minha conta › Notificações.', 'Toque em “Ativar notificações neste dispositivo” e permita.', 'Para instalar, siga as instruções em “Instalar aplicativo”. No iPhone: Safari › Compartilhar › Adicionar à Tela de Início.'],
    result: 'Os avisos chegam no aparelho. Eles também ficam em Notificações, dentro do app.', confirm: 'Aparece “Notificações ativadas”.',
    problems: [['Notificações bloqueadas', 'Libere nas configurações do site no navegador (ícone de cadeado) e volte ao app.'], ['iPhone não recebe', 'Só funciona com o app instalado na Tela de Início (iOS 16.4 ou mais novo).']],
    next: [],
  },
  {
    slug: 'morador-cadastro', title: 'Cadastro aguardando aprovação', category: 'Acesso e cadastro', roles: ['morador'], areas: [], keywords: 'cadastro aprovacao pendente aguardando acesso',
    forWho: 'Morador.', when: 'Logo depois de pedir acesso.',
    before: [],
    steps: ['A administração confere seus dados e a unidade.', 'Você recebe um e-mail com a decisão.', 'Depois de aprovado, suas encomendas aparecem no Início.'],
    result: 'Acesso liberado só para a sua unidade.', confirm: 'O Início mostra sua unidade no topo.', problems: [['Demorou muito', 'Fale com a portaria ou a administração do condomínio.']], next: [],
  },
  {
    slug: 'morador-dados', title: 'Dados incorretos ou problema de acesso', category: 'Acesso e cadastro', roles: ['morador'], areas: [], keywords: 'unidade errada dados incorretos senha acesso portaria contato',
    forWho: 'Morador.', when: 'Unidade errada, nome errado ou acesso encerrado.',
    before: [],
    steps: ['Nome e contatos: Minha conta › Meu perfil.', 'Unidade errada ou mudança: peça à administração; a troca passa por aprovação.', 'Esqueceu a senha: na tela de entrada, use “Esqueci minha senha”.'],
    result: 'Seus dados corrigidos.', confirm: 'Minha conta mostra os dados novos.', problems: [['Contato da portaria', 'Quando cadastrado pelo condomínio, aparece em Minha conta › Ajuda e suporte.']], next: [],
  },

  {
    slug: 'primeiros-passos', title: 'Deixar o condomínio pronto para usar', category: 'Primeiros passos', roles: ['admin'], areas: ['configuracoes', 'painel'], tour: 'inicio-sindico', screen: 'painel',
    forWho: 'Síndico ou administrador que acabou de cadastrar o condomínio.', when: 'Logo depois de ativar o mês grátis.',
    before: ['Conta com e-mail confirmado.', 'Condomínio cadastrado em “Cadastre seu condomínio”.'],
    steps: ['Abra Configurações › Marca e salve nome, logo e cores.', 'Em Configurações › Portarias e locais de guarda, cadastre as prateleiras ou salas com a capacidade de cada uma.', 'Abra Unidades e moradores e cadastre as unidades (em “Nova unidade” ou por planilha).', 'Convide os porteiros em Configurações › Equipe.', 'Compartilhe o link do portal com os moradores (Configurações › Portal e aplicativo) ou convide na linha de cada unidade.', 'Em Encomendas, registre uma encomenda de teste e entregue.'],
    result: 'Porteiros conseguem receber e entregar; moradores recebem avisos.', confirm: 'A Visão geral mostra a encomenda de teste em “Entradas no período”.',
    problems: [['Não aparece “Configurações”', 'Seu acesso não tem a permissão de configurações. Peça ao administrador principal.'], ['Nenhum plano para escolher', 'O catálogo ainda não foi publicado pela Portaria Prime. Fale com o suporte.']],
    next: ['receber-encomenda', 'moradores-e-convites'],
  },
  {
    slug: 'unidades-e-importacao', title: 'Cadastrar unidades e importar planilha', category: 'Síndico', roles: ['admin'], areas: ['pessoas'], tour: 'unidades', keywords: 'apartamento casa bloco torre csv excel',
    forWho: 'Administrador com permissão de aprovar moradores.', when: 'Na implantação ou quando surgir uma nova unidade.',
    before: ['Lista das unidades (bloco e número).'],
    steps: ['Abra Unidades e moradores › Unidades.', 'Para uma unidade: toque em “Nova unidade”, preencha Bloco/Torre (opcional) e Unidade e toque em Adicionar unidade.', 'Para várias: toque em Importar CSV e escolha o arquivo com as colunas bloco e unidade.', 'Confira a prévia e confirme.', 'Para desativar ou reativar, use o menu (⋮) na linha da unidade.'],
    result: 'As unidades aparecem na lista e podem receber encomendas.', confirm: 'O contador “unidades ativas de N no plano” aumenta.',
    problems: [['Erro ao importar CSV', 'Salve a planilha como CSV (separado por vírgula ou ponto e vírgula), com cabeçalho na primeira linha. Linhas repetidas são ignoradas.'], ['Limite do plano atingido', 'O plano tem um número máximo de unidades. Troque de plano em Configurações › Plano e assinatura ou desative unidades que não existem.']],
    next: ['moradores-e-convites'],
  },
  {
    slug: 'moradores-e-convites', title: 'Convidar, aprovar e remover moradores', category: 'Síndico', roles: ['admin'], areas: ['pessoas'], tour: 'moradores', keywords: 'morador convite aprovar vínculo mudança cadastro solicitação portal link qr',
    forWho: 'Administrador com permissão de aprovar moradores.', when: 'Quando um morador chega ou sai.',
    before: ['Unidade cadastrada.', 'E-mail do morador.'],
    steps: ['Sem convite: em Configurações › Portal e aplicativo, copie o link do portal (ou baixe o QR) e compartilhe com os moradores.', 'O morador abre o portal, toca em “Criar minha conta” e informa nome, celular e unidade.', 'Em Unidades e moradores › Solicitações (o número ao lado mostra as pendentes), confira a unidade e toque em Aprovar (ou Recusar com motivo).', 'Com convite (opcional): em Unidades, abra o menu (⋮) da unidade, toque em “Convidar morador” e envie para o e-mail dele.', 'Quando alguém se mudar, revogue o acesso em Unidades e moradores › Moradores.'],
    result: 'O morador vê só as encomendas da unidade dele.', confirm: 'O nome aparece em Moradores com a unidade.',
    problems: [['Morador diz que o convite é inválido', 'Convites expiram em 7 dias e valem uma vez. Gere um novo.'], ['“Enviado para outro e-mail”', 'O morador entrou com outra conta. Ele precisa usar o e-mail do convite.'], ['Morador sem vínculo', 'Saber bloco e número não dá acesso. O vínculo só existe depois da aprovação ou do convite aceito.'], ['A unidade da solicitação não foi encontrada', 'O morador digitou diferente do cadastro. Escolha a unidade correta na lista antes de aprovar; o sistema nunca cria unidade sozinho.']],
    next: ['seguranca-acessos'],
  },
  {
    slug: 'equipe-e-permissoes', title: 'Equipe: porteiros e administradores', category: 'Equipe e portaria', roles: ['admin'], areas: ['configuracoes'], tour: 'equipe', keywords: 'porteiro zelador funcionário permissão',
    forWho: 'Administrador com permissão de equipe.', when: 'Ao contratar ou desligar alguém.',
    before: ['E-mail da pessoa.'],
    steps: ['Abra Configurações › Equipe (também há um atalho em Unidades e moradores).', 'Toque em “Convidar equipe” e escolha Porteiro ou Administrador.', 'Para administrador, marque só as permissões necessárias: equipe, aprovar moradores, configurações, faturamento.', 'Envie e acompanhe os convites pendentes na mesma tela.', 'Para desligar, revogue o acesso na lista.'],
    result: 'A pessoa entra com o acesso escolhido.', confirm: 'Ela aparece na lista com o papel correto.',
    problems: [['Não consigo dar uma permissão', 'Você só pode conceder permissões que você mesmo tem.'], ['Convite antigo parou de funcionar', 'Se quem convidou perdeu a permissão, os convites pendentes dele são revogados.']],
    next: ['receber-encomenda'],
  },
  {
    slug: 'receber-encomenda', title: 'Receber uma encomenda', category: 'Encomendas e retiradas', roles: STAFF, areas: ['portaria', 'totem-equipe'], tour: 'receber', screen: 'recebimento', keywords: 'pacote encomenda chegada registrar etiqueta ocr foto totem estante prateleira',
    forWho: 'Porteiro e administrador.', when: 'Sempre que uma encomenda chegar.',
    before: ['Unidades cadastradas.', 'Assinatura ativa ou mês grátis.'],
    steps: ['Abra Encomendas (ou Totem da portaria) e toque em “Receber encomenda”. Cada etapa abre numa tela, com os botões sempre embaixo.', 'Etapa 1: toque num entregador recente ou digite o nome; escolha a transportadora (as mais usadas aparecem para tocar; “Digitar outra transportadora” para uma nova, que passa a aparecer nas próximas vezes). O porteiro já vem preenchido. Toque em Avançar.', 'Etapa 2: fotografe a etiqueta. Se o plano tiver leitura automática, toque em “Ler etiqueta automaticamente”: o sistema separa destinatário, remetente, complemento, rastreio, pedido e nota, e confere com os moradores ativos.', 'Leia o aviso de conferência. Só “confere” pré-seleciona a unidade; conflito, homônimo ou nome que não confere exigem escolher a unidade.', 'Toque no morador da unidade para preencher o destinatário. Confira o rastreio (o leitor USB funciona no campo) e, se quiser, toque no tipo de volume (caixa, envelope, pacote…).', 'Confira o local sugerido (portaria › estante › prateleira), guarde a encomenda e marque “Guardei fisicamente em…”.', 'Toque em “Salvar e avançar”.', 'Etapa 3: “Cadastrar próxima encomenda” volta à etapa 2 com o mesmo entregador; “Encerrar recebimento” mostra o resumo de tudo que ele deixou. Toque em Finalizar.'],
    result: 'A encomenda fica “aguardando retirada” e todos os moradores ativos da unidade são avisados (app, push, e-mail e WhatsApp, conforme configurado).', confirm: 'Aparece a mensagem “Encomenda registrada para…” e a encomenda está na busca de Encomendas.',
    problems: [['Leitura automática errou', 'A leitura é só sugestão. Corrija os campos antes de salvar.'], ['Local lotado', 'Escolha outro local ou um local de contingência. O sistema não inventa prateleira.'], ['Toquei duas vezes em Salvar', 'O sistema não duplica: a segunda tentativa devolve a mesma encomenda.'], ['“Esta mesma foto já registrou uma encomenda”', 'A foto é idêntica a uma encomenda que ainda aguarda retirada. Confira se não é duplicidade.'], ['Código como “RJ2-2” ou “LSP-105” virou unidade', 'São códigos de triagem da transportadora. O sistema descarta e avisa; escolha a unidade pelo complemento do destinatário.'], ['Recebimentos bloqueados', 'A assinatura está restrita. O síndico regulariza em Configurações › Plano e assinatura; retiradas continuam liberadas.']],
    next: ['entregar-encomenda'],
  },
  {
    slug: 'entregar-encomenda', title: 'Entregar com QR, assinatura e comprovante', category: 'Encomendas e retiradas', roles: STAFF, areas: ['portaria', 'totem-equipe'], tour: 'entregar', screen: 'comprovante', keywords: 'retirada entrega retirar qr assinatura comprovante foto item totem',
    forWho: 'Porteiro e administrador.', when: 'Quando o morador vier buscar.',
    before: ['Encomenda aguardando retirada.'],
    steps: ['Abra Encomendas (ou Totem da portaria) e toque em “Entregar ao morador”. Cada etapa abre numa tela, com os botões sempre embaixo.', 'Etapa 1: toque em “Ler QR Code do morador” (a leitura só consulta: o QR é usado apenas ao confirmar) ou escolha a unidade. Informe quem está retirando e se é morador ou recebedor autorizado.', 'Etapa 2: marque as encomendas da unidade que serão entregues. Sem QR, escreva a justificativa.', 'Etapa 3: para cada encomenda, confira a foto da etiqueta, busque no local mostrado (“Buscar em: portaria › estante › prateleira”), fotografe o item entregue (obrigatório), peça a assinatura na tela e toque em Confirmar entrega. A assinatura é pedida uma vez e vale para todas.', 'No resumo, abra os comprovantes se precisar e toque em “Encerrar entrega”.'],
    result: 'A encomenda vira “Retirada”, o comprovante fica disponível no resumo e todos os moradores da unidade recebem aviso com link do comprovante.', confirm: 'O comprovante mostra protocolo, local de retirada, operador, quem retirou, assinatura e foto do item.',
    problems: [['QR expirado ou já usado', 'Peça ao morador para tocar em “Gerar novo QR”.'], ['QR de outro condomínio', 'O sistema recusa. Confira se o morador está no condomínio certo.'], ['Assinatura ou foto ausente', 'A entrega não é concluída sem assinatura e foto do item.'], ['A internet caiu na hora de confirmar', 'Nada é confirmado offline. Toque em Confirmar de novo quando voltar: se a primeira chegou ao servidor, o mesmo protocolo é devolvido, sem duplicar.'], ['Duas pessoas entregaram ao mesmo tempo', 'Só uma entrega é aceita; a outra recebe aviso de que já foi retirada.']],
    next: ['comprovantes'],
  },
  {
    slug: 'comprovantes', title: 'Abrir e imprimir comprovantes', category: 'Encomendas e retiradas', roles: STAFF, areas: ['portaria', 'morador'], keywords: 'recibo protocolo pdf imprimir',
    forWho: 'Todos.', when: 'Para conferir uma retirada.',
    before: ['Encomenda retirada.'],
    steps: ['Equipe: em Encomendas, abra a aba Histórico, procure a encomenda e toque em Comprovante.', 'Morador: em Minhas encomendas › Histórico, toque em Comprovante, ou abra o link recebido por e-mail/WhatsApp/push (exige login).', 'Toque em “Baixar PDF / imprimir” e escolha “Salvar como PDF”.'],
    result: 'Comprovante com protocolo e dados da retirada.', confirm: 'O protocolo começa com PP-.',
    problems: [['A imagem da assinatura não carrega', 'Os links das imagens são temporários. Feche e abra o comprovante de novo.']],
    next: [],
  },
  {
    slug: 'excecoes', title: 'Mover, devolver, extravio e cancelamento', category: 'Encomendas e retiradas', roles: STAFF, areas: ['portaria'], tour: 'excecoes', keywords: 'devolução extraviada cancelar mover prateleira',
    forWho: 'Porteiro (devolver) e administrador (todas).', when: 'Quando a encomenda sai do fluxo normal.',
    before: ['Encomenda aguardando retirada.'],
    steps: ['Em Encomendas, use a busca e ache a encomenda na lista “Aguardando retirada”.', 'Toque no menu (⋮) da encomenda.', 'Para trocar de local, toque em “Mover de local” e escolha o novo local.', 'Para outras situações, toque em “Registrar exceção”, escolha a situação e escreva o motivo (mínimo de 10 caracteres).'],
    result: 'A mudança fica no histórico com data e responsável.', confirm: 'A situação aparece na Visão geral, aba Análise, em exceções.',
    problems: [['Não aparece Cancelada ou Extraviada', 'Só administradores registram essas situações.']],
    next: ['relatorios'],
  },
  {
    slug: 'armazenamento', title: 'Locais de guarda e ocupação', category: 'Síndico', roles: ['admin'], areas: ['configuracoes', 'painel'], screen: 'armazenamento', keywords: 'prateleira estante armário sala capacidade lotação',
    forWho: 'Administrador com permissão de configurações.', when: 'Na implantação ou ao mudar o espaço físico.',
    before: ['Pelo menos uma portaria.'],
    steps: ['Abra Configurações › Portarias e locais de guarda.', 'Preencha código, capacidade e, se for o caso, marque contingência.', 'Toque em Adicionar.', 'Acompanhe a ocupação na Visão geral.'],
    result: 'O recebimento sugere o local com mais espaço.', confirm: 'O local aparece na Visão geral com uso e capacidade.',
    problems: [['Tudo lotado', 'Aumente a capacidade, crie outro local ou use um local de contingência.']],
    next: ['receber-encomenda'],
  },
  {
    slug: 'relatorios', title: 'Visão geral, relatórios e exportação', category: 'Síndico', roles: ['admin'], areas: ['painel', 'relatorios'], tour: 'relatorios', screen: 'painel', keywords: 'relatório csv planilha exportar indicadores painel visão geral',
    forWho: 'Administrador.', when: 'Para acompanhar a portaria.',
    before: [],
    steps: ['Abra Visão geral (ou Relatórios).', 'Escolha o período (De/Até) e a situação.', 'Veja indicadores, ocupação e a lista de encomendas.', 'Toque em Exportar CSV para baixar a planilha.'],
    result: 'Números do período no fuso do condomínio.', confirm: 'A planilha abre no Excel ou Google Planilhas.',
    problems: [['Lista incompleta', 'Toque em “Carregar mais” no fim da lista.']],
    next: [],
  },
  {
    slug: 'personalizar', title: 'Personalizar marca e cores', category: 'Personalização', roles: ['admin'], areas: ['configuracoes'], tour: 'identidade', screen: 'marcaA', keywords: 'logo cor tema escuro claro identidade',
    forWho: 'Administrador com permissão de configurações.', when: 'Na implantação.',
    before: ['Logo em PNG, JPEG ou WebP (até 1 MB).'],
    steps: ['Abra Configurações › Marca.', 'Mude o nome exibido, envie o logo e escolha as cores.', 'Confira o aviso de contraste.', 'Toque em Salvar.'],
    result: 'Todos do condomínio veem a nova identidade.', confirm: 'O logo aparece no menu.',
    problems: [['Cor com pouco contraste', 'Escolha uma cor mais escura para textos e botões.'], ['SVG não aceito', 'Por segurança, use PNG, JPEG ou WebP.']],
    next: [],
  },
  {
    slug: 'totem', title: 'Totem para entregadores', category: 'Totem', roles: ['admin'], areas: ['configuracoes'], tour: 'totem', keywords: 'tablet quiosque entregador autoatendimento',
    forWho: 'Administrador, nos planos com totem.', when: 'Para o entregador deixar encomendas sem esperar o porteiro.',
    before: ['Plano com totem.', 'Tablet com navegador.'],
    steps: ['Em Configurações › Totem, crie um dispositivo e copie o código.', 'No tablet, abra o endereço do totem e digite o código.', 'O entregador informa transportadora, rastreio e unidade.', 'O porteiro confere em Encomendas (“Deixadas no totem”) antes do aviso ao morador.', 'Revogue o dispositivo se o tablet sumir.'],
    result: 'Pré-registros aparecem para conferência.', confirm: 'O pré-registro some da lista depois de conferido.',
    problems: [['Totem pede código de novo', 'O dispositivo foi revogado ou o condomínio está suspenso.']],
    next: ['receber-encomenda'],
  },
  {
    slug: 'notificacoes', title: 'Avisos no celular e instalar o aplicativo', category: 'Notificações e aplicativo', roles: STAFF, areas: ['aplicativo', 'morador', 'avisos', 'ajuda'], keywords: 'push notificação aviso sino instalar app pwa iphone android',
    forWho: 'Todos.', when: 'Para receber avisos no aparelho.',
    before: ['Navegador compatível com notificações.'],
    steps: ['Abra o menu da sua conta (seu nome, no topo) › Meu aplicativo e notificações.', 'Ative “Avisos neste aparelho” e permita as notificações.', 'Para instalar: no Android/Chrome use “Instalar aplicativo”; no iPhone use Compartilhar › Adicionar à Tela de Início.', 'Os avisos dentro do sistema ficam no sino, no topo da tela.'],
    result: 'Avisos chegam mesmo com o app fechado, quando o aparelho permite.', confirm: 'O botão mostra que os avisos estão ativos.',
    problems: [['Permissão negada', 'Libere as notificações do site nas configurações do navegador e tente de novo.'], ['App não instala', 'É preciso HTTPS e um navegador compatível. No iPhone, só pelo Safari.'], ['Aviso não chegou', 'Avisos dependem do aparelho e do provedor. O aviso dentro do sistema continua no sino, no topo da tela.']],
    next: [],
  },
  {
    slug: 'plano-e-pagamento', title: 'Mês grátis, plano, pagamento e cancelamento', category: 'Plano, teste e cobrança', roles: ['admin'], areas: ['assinatura'], tour: 'assinatura', screen: 'assinatura', keywords: 'teste gratis trial pagar boleto pix cartão cancelar plano preço',
    forWho: 'Administrador com permissão de faturamento.', when: 'Durante e depois do mês grátis.',
    before: [],
    steps: ['Abra Configurações › Plano e assinatura para ver início e fim do mês grátis e o valor depois do teste.', 'Para trocar de plano, escolha plano e ciclo e confirme.', 'Ao fim do teste, toque em “Pagar assinatura” para ir ao link seguro da InfinitePay (Pix ou cartão).', 'Para cancelar, toque em “Cancelar assinatura”.'],
    result: 'O período pago começa depois da confirmação do pagamento pela InfinitePay.', confirm: 'Plano e assinatura mostra “Período pago até…”.',
    problems: [['Paguei e ainda aparece pendente', 'A confirmação é verificada com a InfinitePay e pode levar alguns minutos. Voltar do checkout não confirma o pagamento sozinho.'], ['Teste terminou', 'Há 7 dias de carência. Depois, novos recebimentos ficam bloqueados até o pagamento; consultas e retiradas continuam.'], ['Débito automático', 'Não existe. Cada renovação é paga por link.']],
    next: [],
  },
  {
    slug: 'seguranca-acessos', title: 'Quem vê o quê: segurança e permissões', category: 'Segurança e permissões', roles: STAFF, areas: ['ajuda'], keywords: 'privacidade lgpd acesso dados segurança',
    forWho: 'Todos.', when: 'Para entender os acessos.',
    before: [],
    steps: ['Cada condomínio só vê os próprios dados.', 'Morador vê só a própria unidade; porteiro opera a portaria; administrador vê só o que as permissões dele permitem.', 'Fotos e assinaturas abrem por links temporários, só para quem tem acesso.', 'Acesso revogado vale na próxima ação, mesmo com o app aberto.'],
    result: 'Dados separados por condomínio e por pessoa.', confirm: 'Ao trocar de condomínio, o sistema troca marca e dados.',
    problems: [['Vejo um condomínio que não é meu', 'Avise o suporte imediatamente.']],
    next: [],
  },
  {
    slug: 'camera', title: 'Câmera negada ou indisponível', category: 'Solução de problemas', roles: STAFF, areas: ['portaria'], keywords: 'câmera permissão foto qr leitor',
    forWho: 'Equipe.', when: 'Quando a câmera não abre.',
    before: [],
    steps: ['Libere a câmera para o site nas configurações do navegador.', 'Sem câmera: envie uma imagem salva ou digite os dados da etiqueta.', 'Para entregar sem leitor de QR, escolha a unidade em “Entregar ao morador” e escreva a justificativa.'],
    result: 'O trabalho continua sem câmera.', confirm: 'A encomenda é registrada normalmente.', problems: [], next: ['receber-encomenda'],
  },
  {
    slug: 'sem-internet', title: 'A internet caiu', category: 'Solução de problemas', roles: STAFF, areas: ['portaria', 'morador'], keywords: 'offline internet conexão caiu',
    forWho: 'Todos.', when: 'Sem conexão.',
    before: [],
    steps: ['Não considere recebimentos, retiradas ou pagamentos feitos sem a confirmação do servidor.', 'Anote em papel o que for urgente.', 'Quando a conexão voltar, registre e confira as mensagens de confirmação.'],
    result: 'Nada é dado como feito sem o servidor confirmar.', confirm: 'A encomenda aparece na busca de Encomendas depois de registrada.', problems: [], next: [],
  },
  {
    slug: 'aviso-nao-enviado', title: 'Aviso ao morador não foi enviado', category: 'Solução de problemas', roles: ['admin'], areas: ['painel', 'configuracoes'], keywords: 'whatsapp email aviso falha notificação',
    forWho: 'Administrador.', when: 'A Visão geral ou o sino mostram aviso com falha.',
    before: [],
    steps: ['Confira em Configurações se o canal (e-mail/WhatsApp) está configurado e ativo.', 'Confira se o morador tem contato cadastrado.', 'O sistema tenta de novo automaticamente algumas vezes.'],
    result: 'A encomenda continua registrada mesmo se o aviso falhar.', confirm: 'O contador de falhas diminui.', problems: [], next: [],
  },
  // ---- Modo Portaria Exclusiva (quiosque Android gerenciado, acesso piloto). Comportamento: docs/KIOSK_ANDROID.md ----
  {
    slug: 'portaria-exclusiva', title: 'Modo Portaria Exclusiva: o que é e como ativar', category: 'Síndico', roles: ['admin'], areas: ['configuracoes'], screen: 'quiosqueRecebimento',
    keywords: 'quiosque kiosk tablet android dispositivo dedicado bloqueio piloto pwa iphone ipad formatar restauração de fábrica compatível',
    forWho: 'Síndico ou administrador.', when: 'Para usar um Android do condomínio como terminal dedicado à portaria.',
    before: ['Recurso incluído em todos os planos, de uso opcional e sem cobrança de ativação, em acesso piloto: a liberação depende de validação de compatibilidade.',
      'O modo quiosque exige dispositivo Android compatível, dedicado à portaria, e configuração inicial. Equipamento não incluso.',
      'Não funciona em iPhone ou iPad. O app instalado pelo navegador (PWA) dá acesso ao sistema, mas não bloqueia o aparelho.'],
    steps: ['Peça a ativação piloto na página inicial do Portaria Prime (“Solicitar ativação piloto”), informando marca, modelo e versão do Android.',
      'Com a liberação, prepare o aparelho: a configuração oficial pelo QR acontece na tela inicial do Android e exige restauração de fábrica, que apaga os dados. Faça backup e remova contas pessoais.',
      'Vincule o aparelho em Configurações › Dispositivos e quiosque › “Adicionar dispositivo” e gere o QR.',
      'Ative e gerencie pelo painel: situação do aparelho, manutenção com prazo e códigos de recuperação.'],
    result: 'O aparelho abre direto na portaria do condomínio e volta a ela depois de reiniciar.', confirm: 'Em Dispositivos e quiosque o aparelho aparece como “Ativo”.',
    problems: [['Posso usar sem formatar?', 'O método oficial exige restauração de fábrica. Em alguns aparelhos sem contas existe configuração técnica por cabo sem restauração, mas depende do fabricante e é avaliada pela equipe.'],
      ['O que funciona sem internet?', 'O aparelho continua travado com a última configuração. Recebimentos, entregas e comprovantes só são confirmados com conexão.'],
      ['Como libero para manutenção?', 'Em Detalhes, “Abrir manutenção” com prazo: termina sozinha. Sem internet no aparelho, use um código de recuperação de uso único.'],
      ['Como retiro o gerenciamento?', 'Use “Desativar gerenciamento” com o aparelho on-line. Em alguns modelos, voltar ao uso comum pode exigir restauração de fábrica.'],
      ['Quantos aparelhos posso cadastrar?', 'Até 20 aparelhos ativos por condomínio, em qualquer plano (limite técnico). Aparelhos com desativação pendente ainda contam; só os desativados liberam a vaga. Ao chegar a 20, desative um aparelho para cadastrar outro.']],
    next: ['portaria-exclusiva-porteiro'],
  },
  {
    slug: 'portaria-exclusiva-porteiro', title: 'Trabalhar no terminal da portaria (Android dedicado)', category: 'Equipe e portaria', roles: STAFF, areas: ['portaria'],
    keywords: 'quiosque tablet terminal turno sair login manutenção android dedicado',
    forWho: 'Equipe da portaria.', when: 'Quando o condomínio usa o Modo Portaria Exclusiva.',
    before: ['Aparelho já configurado pelo síndico.'],
    steps: ['Entre com a sua própria conta; o aparelho não tem senha compartilhada.', 'Receba, entregue e busque normalmente: foto da etiqueta, QR, assinatura, foto do item e comprovante funcionam dentro do app.',
      'No fim do turno, use “Sair” no menu da conta para o próximo colega entrar.', 'Precisa de ajuste no aparelho? Peça ao síndico. O botão “Manutenção” só funciona com código do síndico.'],
    result: 'Cada ação fica registrada no nome de quem estava logado.', confirm: 'Seu nome aparece no menu da conta.',
    problems: [['Aviso de sem contato com o servidor', 'Sem internet nada é confirmado. Anote e registre quando a conexão voltar.'], ['O aparelho reiniciou', 'Ele volta sozinho ao Portaria Prime; entre de novo com a sua conta.']],
    next: ['sem-internet'],
  },
  {
    slug: 'suporte', title: 'Falar com o suporte', category: 'Suporte', roles: STAFF, areas: ['ajuda'], keywords: 'contato ajuda atendimento suporte',
    forWho: 'Todos.', when: 'Quando a ajuda não resolver.',
    before: [],
    steps: ['Na Central de ajuda, toque em “Falar com o suporte” e preencha o formulário.', 'Descreva a tela, o que tentou fazer e a mensagem de erro. Não envie senhas.'],
    result: 'Sua mensagem fica registrada para a equipe da Portaria Prime.', confirm: 'Aparece a confirmação de recebimento.', problems: [], next: [],
  },
];

const SYNONYMS: string[][] = [
  ['pacote', 'encomenda', 'caixa', 'correspondencia', 'entrega'],
  ['apartamento', 'unidade', 'apto', 'ap', 'casa'],
  ['entrega', 'retirada', 'retirar', 'buscar', 'entregar'],
  ['sindico', 'administrador', 'admin', 'gestor'],
  ['porteiro', 'portaria', 'zelador', 'equipe'],
  ['aviso', 'notificacao', 'push', 'alerta'],
  ['pagamento', 'pagar', 'cobranca', 'assinatura', 'plano', 'preco'],
  ['teste', 'gratis', 'trial'],
  ['qr', 'qrcode', 'codigo'],
];

export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const haystack = (a: Article) => normalize([a.title, a.category, a.forWho, a.when, a.keywords || '', ...a.steps, ...a.problems.flat()].join(' '));

/** Busca tolerante a acentos e sinônimos; cada termo (ou um sinônimo dele) precisa aparecer. */
export function searchArticles(list: Article[], q: string): Article[] {
  const terms = normalize(q).split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return list;
  const expand = (t: string) => SYNONYMS.find((g) => g.some((w) => w.startsWith(t) || t.startsWith(w))) || [t];
  return list.filter((a) => { const h = haystack(a); return terms.every((t) => expand(t).concat(t).some((w) => h.includes(w))); });
}

export const articlesFor = (role: Role) => ARTICLES.filter((a) => a.roles.includes(role));
export const articleFor = (area: string, role: Role) => articlesFor(role).find((a) => a.areas.includes(area));
