---
kind: contrato_saas
version: 1.0
summary: Contrato oficial do Portaria Prime (versão 1.0). Os dados do condomínio, do síndico e do plano são preenchidos automaticamente na contratação; o contrato é assinado eletronicamente pelas duas partes na Autentique. Um mês de teste grátis; depois, mensalidade do plano escolhido via InfinitePay.
---

# CONTRATO DE LICENCIAMENTO DE SOFTWARE (SaaS), PRESTAÇÃO DE SERVIÇOS DE TECNOLOGIA E TRATAMENTO DE DADOS PESSOAIS – PORTARIA PRIME

**VERSÃO OFICIAL 1.0 — PREENCHIMENTO AUTOMÁTICO E ASSINATURA ELETRÔNICA VIA AUTENTIQUE**

Pelo presente instrumento particular, de um lado:

CONTRATADA: 59.760.458/0001-91 MARCO ANTONIO BOGGIAN, empresário individual enquadrado como Microempreendedor Individual – MEI, inscrito no CNPJ sob nº 59.760.458/0001-91, com endereço comercial na Rua Jacques Pilon, nº 189, Vila Piauí, São Paulo/SP, CEP 05109-160, titular e licenciante da plataforma eletrônica PORTARIA PRIME (https://portariaprime.com.br), neste ato representado por seu titular, Marco Antonio Boggian, e-mail oficial avisos@portariaprime.com.br, doravante denominada simplesmente CONTRATADA; e, de outro lado:

CONTRATANTE: {{CONDOMINIO_NOME}}, inscrito no CNPJ/CPF sob nº {{CONDOMINIO_CNPJ}}, situado em {{CONDOMINIO_ENDERECO}}, neste ato representado por seu síndico(a) ou administrador(a) legal {{SINDICO_NOME}}, inscrito(a) no CPF sob nº {{SINDICO_CPF}}, e-mail {{SINDICO_EMAIL}} e telefone/WhatsApp {{SINDICO_TELEFONE}}, doravante denominado(a) simplesmente CONTRATANTE;

CONTRATADA e CONTRATANTE, conjuntamente denominadas Partes, resolvem celebrar o presente Contrato de Licenciamento de Software, Prestação de Serviços de Tecnologia e Tratamento de Dados Pessoais, que se regerá pela legislação brasileira aplicável (em especial a Lei nº 9.609/1998, o Código Civil, o art. 784, § 4º do Código de Processo Civil e a Lei nº 13.709/2018 – LGPD) e pelas cláusulas e condições seguintes.

## CLÁUSULA 1ª – DEFINIÇÕES

1.1. Para fins deste contrato, aplicam-se as seguintes definições:

I – Plataforma: sistema eletrônico SaaS multi-tenant denominado Portaria Prime (acessível em https://portariaprime.com.br, via navegador, PWA ou aplicativo Android complementar), incluindo painéis, APIs, bancos de dados operacionais, documentação e recursos habilitados no plano contratado;

II – Usuários: síndicos, administradores, porteiros, controladores de acesso, zeladores, moradores, condôminos, entregadores e demais pessoas vinculadas ou autorizadas pela CONTRATANTE a utilizar ou interagir com a Plataforma;

III – Dados da CONTRATANTE: informações, cadastros de unidades e moradores, planilhas importadas, fotos de encomendas e etiquetas, imagens e dados de documentos de entregadores (CNH/RG/CPF), registros biométricos faciais de funcionários da portaria, assinaturas em tela, palavras-chave de recebimento, logs e demais conteúdos inseridos ou gerados na operação da CONTRATANTE;

IV – Dados Pessoais e Dados Pessoais Sensíveis: informações relacionadas a pessoa natural identificada ou identificável, incluindo dados biométricos faciais e imagens de documentos tratados nos termos da Lei nº 13.709/2018 (LGPD);

V – Recursos de Inteligência Artificial (OCR e Biometria): ferramentas automatizadas de visão computacional e leitura óptica de caracteres (OCR) utilizadas para leitura assistida de etiquetas de encomendas, leitura de documentos (CNH/RG) de entregadores/funcionários e verificação facial de turno da portaria;

VI – Modo Portaria Exclusiva (Kiosk Android): módulo complementar e opcional, fornecido em caráter piloto para dispositivos Android compatíveis, destinado a restringir o aparelho da portaria ao uso operacional da Plataforma;

VII – Incidente de Segurança: evento confirmado que comprometa a confidencialidade, integridade ou disponibilidade de Dados Pessoais tratados sob responsabilidade direta da CONTRATADA;

VIII – Indisponibilidade: período em que as funções essenciais de registro e baixa de encomendas da Plataforma não puderem ser acessadas por falha exclusivamente atribuível à infraestrutura sob controle direto da CONTRATADA, excluídas as hipóteses da Cláusula 9ª.

## CLÁUSULA 2ª – OBJETO

2.1. O presente contrato tem por objeto: (I) a concessão de licença de uso temporária, não exclusiva, não sublicenciável, revogável nas hipóteses contratuais e intransferível da Plataforma Portaria Prime; e (II) a prestação de serviços tecnológicos de disponibilização em nuvem, manutenção corretiva/evolutiva, suporte remoto e tratamento de dados necessários à execução da Plataforma.

2.2. A Plataforma destina-se exclusivamente ao apoio tecnológico na gestão de encomendas, correspondências, identificação cadastral de entregadores, autenticação de turno de portaria e comunicação com moradores no empreendimento da CONTRATANTE.

2.3. O objeto deste contrato NÃO compreende, em nenhuma hipótese, a prestação física de serviços de portaria, vigilância, segurança patrimonial ou pessoal, custódia, depósito, transporte, seguro de cargas, conferência de conteúdo de pacotes ou substituição dos empregados, prepostos e procedimentos físicos da CONTRATANTE.

2.4. A licença contratada não implica cessão ou transferência de código-fonte, algoritmos, propriedade intelectual, marcas, segredos de negócio, arquitetura de banco de dados ou qualquer ativo imaterial da CONTRATADA.

## CLÁUSULA 3ª – ESCOPO FUNCIONAL E MÓDULOS DO SISTEMA

3.1. Conforme o plano contratado no Anexo I, a Plataforma poderá disponibilizar os seguintes módulos e funcionalidades:

I – Suporte a condomínios verticais e horizontais (configuração flexível de Bloco/Apartamento, Torre/Unidade, Quadra/Lote, Rua/Casa ou nomenclatura personalizada);

II – Cadastro, edição, aprovação, revogação e exclusão de unidades e moradores pelo síndico, bem como ferramenta de pesquisa dinâmica e importação em lote de planilhas (CSV/XLSX) com disparo de convites de ativação;

III – Registro de chegada de encomendas com suporte a leitura assistida de etiquetas por IA (OCR), pop-up de confirmação visual obrigatória pelo porteiro, alocação em estantes/compartimentos e geração de QR Code de retirada;

IV – Identificação e cadastro básico de entregadores na portaria mediante leitura OCR de CNH/documento ou preenchimento manual, com histórico de entregas consultável pelo síndico;

V – Autocadastro de funcionários da portaria (porteiros) via link/QR Code com coleta de aceite LGPD, login por documento com verificação facial ao vivo e expiração automática de sessão a cada 12 (doze) horas (controle de turno);

VI – Envio de notificações eletrônicas aos moradores (via WhatsApp, E-mail transacional com comprovante PDF e/ou Web Push, conforme disponibilidade técnica e permissões do usuário);

VII – Funcionalidades no aplicativo do morador para acompanhamento de encomendas, apresentação de QR Code de retirada, acionamento do botão de Recusa de Encomenda (compra cancelada ou unidade incorreta) e registro voluntário de Palavra-Chave/PIN para entregas que exijam código junto à transportadora;

VIII – Gestão de encomendas com 'Morador Não Identificado' (por ausência de cadastro ou nome incompleto na etiqueta), permitindo reatribuição e saneamento pelo síndico;

IX – Baixa de entrega mediante leitura de QR Code ou confirmação manual, coleta de assinatura digital na tela, fotografia do pacote/retirada e emissão de comprovante digital auditável em PDF;

X – Módulo opcional 'Modo Portaria Exclusiva (Kiosk Android)' em caráter piloto para dispositivos Android compatíveis e homologados.

3.2. Somente estarão incluídos os módulos, franquias e limites correspondentes ao plano selecionado pela CONTRATANTE no ato da contratação e descritos no Anexo I.

3.3. Não estão incluídos no preço do software o fornecimento de celulares, tablets, totens, computadores, câmeras, impressoras, chips de telefonia, planos de internet ou serviços presenciais.

## CLÁUSULA 4ª – CADASTRO, PERÍODO DE TESTE GRATUITO (FREE TRIAL) E IMPLANTAÇÃO

4.1. Ao aderir à Plataforma na página de planos, os dados informados pela CONTRATANTE no formulário eletrônico preenchem automaticamente este contrato e o Anexo I, seguindo para assinatura eletrônica das Partes via plataforma Autentique.

4.2. PERÍODO DE TESTE GRATUITO (1 MÊS GRÁTIS): Salvo disposição diversa na oferta comercial selecionada, a CONTRATANTE fará jus a 1 (um) mês-calendário (30 dias corridos) de teste gratuito a contar da data de criação da conta do condomínio, sem cobrança de taxa de implantação nos planos autogeridos.

4.3. Durante o Período de Teste Gratuito, qualquer das Partes poderá encerrar o uso e rescindir o presente instrumento imediatamente, diretamente pelo painel ou por comunicação escrita, sem incidência de qualquer multa, aviso prévio ou cobrança de mensalidade.

4.4. Não havendo manifestação de cancelamento até o término do Período de Teste Gratuito e sendo confirmado o pagamento da primeira mensalidade do plano escolhido, o contrato prosseguirá em plena vigência regular pelo prazo da Cláusula 13ª.

4.5. Considera-se concluída a implantação no momento da liberação das credenciais de acesso da CONTRATANTE à Plataforma.

## CLÁUSULA 5ª – OBRIGAÇÕES DA CONTRATADA

5.1. São obrigações da CONTRATADA:

I – Disponibilizar a Plataforma em ambiente de nuvem conforme o plano contratado;

II – Prestar suporte técnico remoto nos horários e canais definidos na Cláusula 10ª e no Anexo I;

III – Corrigir falhas comprovadas de programação atribuíveis exclusivamente à Plataforma;

IV – Empregar medidas técnicas e administrativas razoáveis de segurança da informação, controle de acesso multi-tenant (isolamento lógico por condomínio) e criptografia em trânsito (HTTPS/TLS);

V – Comunicar à CONTRATANTE eventuais incidentes relevantes de segurança confirmados em sua infraestrutura que afetem Dados Pessoais da CONTRATANTE;

VI – Permitir a exportação dos dados cadastrais e operacionais básicos da CONTRATANTE nos formatos disponibilizados pelo sistema (CSV/PDF);

VII – Manter sigilo sobre os Dados da CONTRATANTE.

## CLÁUSULA 6ª – OBRIGAÇÕES E DECLARAÇÕES DA CONTRATANTE

6.1. São obrigações exclusivas da CONTRATANTE:

I – Efetuar pontualmente o pagamento das mensalidades após o período de teste gratuito;

II – Fornecer dados cadastrais reais, exatos e atualizados do condomínio e de seu representante legal;

III – Garantir que possui base legal legítima (nos termos dos arts. 7º e 11 da LGPD) para inserir dados de moradores, importar planilhas cadastrais (CSV/XLSX), disparar convites de ativação, fotografar encomendas/documentos de entregadores e coletar biometria facial de seus porteiros/funcionários;

IV – Afixar aviso visível na portaria física informando a moradores, visitantes, entregadores e funcionários que o condomínio utiliza sistema informatizado de registro de encomendas, captura de imagem documental e autenticação biométrica para fins de segurança operacional e auditoria;

V – Orientar e fiscalizar seus porteiros e prepostos quanto à obrigatoriedade de conferência visual de todas as etiquetas lidas por OCR antes de confirmar o registro no pop-up da Plataforma;

VI – Revogar imediatamente no painel do síndico o acesso de funcionários desligados, ex-moradores ou aparelhos substituídos;

VII – Manter a guarda física segura de todas as encomendas na portaria e conferir presencialmente a identidade do recebedor no ato da entrega;

VIII – Manter livro ou protocolo manual de contingência na portaria para uso imediato em caso de queda de energia elétrica, queda de internet local ou manutenção técnica.

6.2. A CONTRATANTE é a única e exclusiva responsável pela veracidade dos dados inseridos por seus síndicos, porteiros e moradores, bem como pelo uso das credenciais vinculadas ao seu condomínio.

## CLÁUSULA 7ª – REGRAS ESPECÍFICAS DE OPERAÇÃO: IA (OCR), PALAVRA-CHAVE, RECUSA, CNH, FACIAL E MODO KIOSK

7.1. CARÁTER AUXILIAR DA INTELIGÊNCIA ARTIFICIAL (OCR DE ETIQUETAS E CNH): A CONTRATANTE declara plena ciência de que os recursos de leitura óptica de caracteres (OCR) de etiquetas e de CNH baseiam-se em modelos probabilísticos de Inteligência Artificial, sujeitos a variações conforme iluminação, foco, reflexo, rasuras ou layout da transportadora. O OCR NÃO substitui a conferência humana: é obrigação estrita do porteiro verificar e confirmar os dados lidos (Bloco/Quadra, Apartamento/Lote, Nome e Documento) no pop-up de confirmação antes de salvar o registro. A CONTRATADA não responde por erros de endereçamento decorrentes de confirmação humana sem conferência.

7.2. PALAVRA-CHAVE DE ENTREGA E ENCOMENDAS DE ALTO VALOR: O campo 'Palavra-Chave de Entrega' disponibilizado no aplicativo do morador para visualização da portaria constitui ferramenta meramente informativa de conveniência interna entre condômino e portaria. A CONTRATADA não participa da entrega física, não valida o conteúdo ou valor de mercadorias e NÃO responderá, sob qualquer título ou fundamento, por extravio, furto, roubo, golpe de falsos entregadores, entrega de pacotes violados ou uso indevido da palavra-chave por funcionários da portaria ou terceiros.

7.3. RECUSA DE ENCOMENDA PELO MORADOR E MORADOR NÃO IDENTIFICADO: O acionamento do botão 'Recusar Encomenda' pelo morador no aplicativo, bem como o registro de pacotes na aba 'Morador Não Identificado', gera apenas sinalização eletrônica interna no painel do condomínio. Cabe exclusivamente à CONTRATANTE realizar a separação física do pacote, a devolução junto à transportadora ou a correta destinação interna, sem qualquer responsabilidade da CONTRATADA por prazos de devolução postal ou disputas comerciais entre morador e loja.

7.4. LOGIN FACIAL DE PORTEIROS E TURNOS DE 12 HORAS: O reconhecimento facial de funcionários da portaria e a expiração automática de sessão a cada 12 (doze) horas visam auxiliar a rastreabilidade de turnos da CONTRATANTE, cabendo ao síndico auditar periodicamente os registros de acesso e orientar sua equipe a não compartilhar terminais abertos.

7.5. MODO PORTARIA EXCLUSIVA (KIOSK ANDROID / MDM – ACESSO PILOTO): O módulo de gerenciamento e trava de dispositivos Android é de ativação estritamente opcional e fornecido em caráter piloto ('no estado em que se encontra' / as-is), compatível apenas com aparelhos Android previamente homologados:

a) A CONTRATANTE declara ciência de que o provisionamento técnico do Android como Device Owner pode exigir a RESTAURAÇÃO DE FÁBRICA (formatação completa) do aparelho, apagando todos os dados anteriores nele contidos;

b) É obrigação exclusiva da CONTRATANTE utilizar aparelho dedicado somente à portaria, realizar backup prévio de quaisquer dados antes da ativação e guardar em local seguro o código de manutenção e recuperação do síndico;

c) A CONTRATADA não responderá por perda de fotos, contatos ou arquivos locais do aparelho, incompatibilidades de fabricantes (Samsung, Xiaomi, Motorola, Positivo etc.), atualizações do sistema operacional Android ou necessidade de formatação física via modo recovery.

## CLÁUSULA 8ª – LICENÇA DE USO E PROPRIEDADE INTELECTUAL

8.1. A licença de uso é concedida exclusivamente para a operação interna do condomínio identificado no preâmbulo e no Anexo I, sendo expressamente vedado à CONTRATANTE: (I) sublicenciar, ceder, alugar ou compartilhar o acesso com outros condomínios ou empresas; (II) copiar, modificar, criar obras derivadas ou explorar comercialmente a Plataforma; (III) realizar engenharia reversa, descompilação, scraping ou testes de intrusão não autorizados.

8.2. Todos os direitos autorais, marcas, layout, banco de dados estrutural, fluxos operacionais e código-fonte do Portaria Prime pertencem única e exclusivamente à CONTRATADA (Lei nº 9.609/1998).

## CLÁUSULA 9ª – DISPONIBILIDADE, MENSAGERIA DE TERCEIROS E MANUTENÇÃO

9.1. A Plataforma buscará atingir índice médio de disponibilidade mensal (SLA) de 99,0% (noventa e nove por cento), desconsideradas as janelas de manutenção e fatores externos.

9.2. EXCLUDENTES DE INDISPONIBILIDADE: Não configuram falha ou indisponibilidade imputável à CONTRATADA: (I) manutenções programadas ou emergenciais de segurança; (II) falhas de conexão de internet, Wi-Fi, rede móvel ou energia elétrica da CONTRATANTE ou dos moradores; (III) instabilidades em provedores externos de nuvem, DNS (Cloudflare), hospedagem (Vercel), banco de dados (Supabase) ou inteligência artificial; (IV) caso fortuito, força maior ou ataques DDoS.

9.3. ISENÇÃO SOBRE WHATSAPP, E-MAIL E WEB PUSH: O envio e recebimento de mensagens via WhatsApp, E-mail e notificações Push dependem de serviços de terceiros (Meta Platforms/WhatsApp, operadoras telefônicas, provedores de e-mail, Google FCM e Apple APNs) e de configurações nos celulares dos destinatários. A CONTRATADA NÃO garante entrega instantânea de mensagens externas e NÃO se responsabiliza por atrasos, filtros de caixa de spam, desativação de notificações pelo morador, mudanças de política da Meta ou bloqueio/banimento de números de WhatsApp utilizados para envios em massa ou convites de planilhas.

## CLÁUSULA 10ª – SUPORTE TÉCNICO

10.1. O suporte técnico será prestado remotamente por e-mail (avisos@portariaprime.com.br) e WhatsApp comercial oficial, de segunda a sexta-feira, das 09h00 às 18h00 (horário de Brasília), exceto feriados nacionais.

10.2. Os prazos estimados para primeira resposta em horário comercial são: (I) Incidente Crítico (sistema totalmente inacessível): até 4 horas úteis; (II) Incidente Alto: até 1 dia útil; (III) Dúvidas e Solicitações Comuns: até 3 dias úteis.

## CLÁUSULA 11ª – PREÇOS, FATURAMENTO E PAGAMENTO (INFINITEPAY / PIX / CARTÃO)

11.1. Após o término do Período de Teste Gratuito de 30 (trinta) dias previsto na Cláusula 4.2, pela licença de uso e serviços objeto deste contrato, a CONTRATANTE pagará à CONTRATADA a mensalidade correspondente ao plano contratado e especificado no Quadro Resumo do Anexo I.

11.2. Os pagamentos serão processados por meio da plataforma parceira InfinitePay (via PIX, link de pagamento, cartão de crédito) ou outro meio oficial disponibilizado pela CONTRATADA no painel financeiro do condomínio.

11.3. A mensalidade é devida pela disponibilização da Plataforma no ciclo mensal, independentemente do volume efetivo de encomendas registradas pela CONTRATANTE no período.

11.4. O atraso no pagamento sujeitará o valor devido à incidência automática de multa moratória de 2% (dois por cento), juros de mora de 1% (um por cento) ao mês calculados pro rata die e atualização monetária pelo IPCA.

11.5. Os valores dos planos serão reajustados anualmente, ou na menor periodicidade permitida em lei, pela variação positiva do IPCA (IBGE) acumulada no período, ou outro índice oficial que venha a substituí-lo.

## CLÁUSULA 12ª – INADIMPLEMENTO E SUSPENSÃO DE ACESSO

12.1. Verificado o atraso no pagamento após o vencimento, a CONTRATADA enviará aviso eletrônico de cobrança à CONTRATANTE.

12.2. Persistindo a inadimplência por prazo superior a 15 (quinze) dias corridos após o vencimento, a CONTRATADA poderá suspender preventivamente o registro de novas encomendas e o acesso operacional à Plataforma, mantendo preservados os dados históricos e a possibilidade de exportação pelo prazo contratual.

12.3. A reativação do acesso ocorrerá em até 24 (vinte e quatro) horas úteis após a confirmação da quitação integral dos valores em aberto.

## CLÁUSULA 13ª – VIGÊNCIA, RENOVAÇÃO E RESCISÃO

13.1. O presente contrato entra em vigor na data de sua assinatura/aceite eletrônico e vigorará pelo prazo inicial de 12 (doze) meses (computado o período inicial de teste), renovando-se automaticamente por períodos sucessivos ou por prazo indeterminado, salvo manifestação contrária de qualquer das Partes com antecedência mínima de 30 (trinta) dias.

13.2. RESCISÃO SEM ÔNUS NO PERÍODO DE TESTE: Durante os primeiros 30 (trinta) dias de teste gratuito, qualquer das Partes poderá rescindir o contrato imediatamente e sem qualquer multa ou encargo.

13.3. RESCISÃO APÓS O PERÍODO DE TESTE: Após a confirmação do plano pago, qualquer das Partes poderá rescindir o presente contrato mediante aviso prévio escrito com antecedência mínima de 30 (trinta) dias, quitando-se proporcionalmente os serviços disponibilizados até a data do encerramento.

13.4. O contrato poderá ser rescindido de pleno direito e imediatamente, independentemente de aviso prévio, em caso de: (I) inadimplemento superior a 30 (trinta) dias; (II) uso ilícito, fraudulento ou violação de propriedade intelectual da Plataforma; (III) insolvência, falência ou encerramento das atividades de qualquer das Partes.

## CLÁUSULA 14ª – EXPORTAÇÃO DE DADOS E ENCERRAMENTO DA CONTA

14.1. Encerrado o contrato por qualquer motivo, a CONTRATANTE disporá do prazo de 30 (trinta) dias corridos para baixar e exportar diretamente pelo painel (ou solicitar ao suporte) seus relatórios de unidades, moradores e histórico de encomendas em formato CSV ou PDF.

14.2. Decorrido o prazo de 30 (trinta) dias do encerramento sem obrigação legal de retenção, a CONTRATADA fica autorizada a excluir definitivamente de seus servidores de produção os dados, imagens e registros operacionais da CONTRATANTE, ressalvada a guarda dos registros de aceite contratual, logs de auditoria jurídica e notas fiscais para exercício regular de direitos em processos judiciais ou administrativos (art. 16, I da LGPD).

## CLÁUSULA 15ª – PROTEÇÃO DE DADOS PESSOAIS (LGPD – LEI Nº 13.709/2018)

15.1. PAPÉIS DAS PARTES: No âmbito do tratamento de Dados Pessoais de moradores, condôminos, porteiros, funcionários, prestadores e entregadores inseridos na Plataforma, a CONTRATANTE figura como CONTROLADORA DE DADOS (art. 5º, VI da LGPD), a quem compete as decisões referentes ao tratamento e a relação direta com os titulares no condomínio, e a CONTRATADA figura estritamente como OPERADORA DE DADOS (art. 5º, VII da LGPD), realizando o processamento técnico segundo as configurações e comandos da CONTRATANTE.

15.2. AUTORIZAÇÃO EXPRESSA PARA DADOS OPERACIONAIS, DOCUMENTOS E BIOMETRIA: A CONTRATANTE autoriza e instrui expressamente a CONTRATADA a tratar, em nome do condomínio, as categorias de dados detalhadas no Anexo II, incluindo: (a) dados cadastrais de unidades e moradores; (b) fotografias de encomendas, etiquetas e assinaturas de retirada; (c) dados e imagens de CNH/documentos de entregadores coletados na portaria; e (d) dados biométricos faciais e documentos de funcionários da portaria para autenticação de turno e prevenção à fraude (art. 11, II, 'a' e 'g' da LGPD).

15.3. RESPONSABILIDADE DO CONTROLADOR E DIREITO DE REGRESSO: Compete exclusivamente à CONTRATANTE garantir a transparência perante os titulares em seu condomínio, atender requerimentos de moradores/entregadores/funcionários na condição de Controladora e abster-se de inserir dados ilícitos. Caso a CONTRATADA venha a ser demandada judicial ou administrativamente (inclusive perante a ANPD, Procon ou Justiça Comum/Trabalhista) por ato atribuível à coleta, importação de planilhas, ausência de aviso local na portaria ou instrução da CONTRATANTE, esta obriga-se a requerer a imediata exclusão da CONTRATADA da lide e a ressarcir integralmente, em sede de regresso, todas as condenações, multas, custas e honorários advocatícios despendidos pela CONTRATADA.

15.4. DEVERES DA OPERADORA: A CONTRATADA compromete-se a tratar os Dados Pessoais exclusivamente para as finalidades contratuais do Portaria Prime, não comercializar dados de moradores ou entregadores com terceiros, manter controles lógicos de isolamento entre condomínios (Row-Level Security) e notificar a CONTRATANTE em até 48 (quarenta e oito) horas úteis após a confirmação de qualquer incidente de segurança relevante ocorrido em sua própria infraestrutura.

## CLÁUSULA 16ª – SUBOPERADORES E INFRAESTRUTURA EM NUVEM

16.1. A CONTRATANTE autoriza a utilização, pela CONTRATADA, de suboperadores de tecnologia de primeira linha necessários à execução do SaaS, incluindo provedores de banco de dados e storage em nuvem (Supabase/AWS), rede de entrega e segurança (Cloudflare/Vercel), processamento de OCR por Inteligência Artificial (Google Gemini API), envio de e-mails transacionais (Resend), assinatura digital (Autentique) e processamento de pagamentos (InfinitePay), inclusive quando envolverem servidores situados no exterior sob padrões internacionais de segurança (art. 33 da LGPD).

## CLÁUSULA 17ª – SEGURANÇA DA INFORMAÇÃO E AUDITORIA

17.1. A Plataforma registra trilhas de auditoria contendo identificadores de sessão, data/hora (timestamps), endereço IP e ações críticas realizadas pelos usuários.

17.2. A guarda e o sigilo das senhas de acesso, códigos de recuperação do Modo Kiosk e links de convite gerados pelo síndico são de responsabilidade exclusiva da CONTRATANTE.

## CLÁUSULA 18ª – CONFIDENCIALIDADE

18.1. As Partes obrigam-se a manter em absoluto sigilo todas as informações confidenciais, listas de moradores, dados operacionais e condições comerciais a que tiverem acesso em virtude deste contrato, durante sua vigência e pelo prazo de 5 (cinco) anos após a sua extinção.

## CLÁUSULA 19ª – LIMITAÇÃO DE RESPONSABILIDADE CIVIL E ISENÇÕES

19.1. ISENÇÃO DE DANOS INDIRETOS E OPERACIONAIS: A CONTRATADA NÃO responderá, em nenhuma hipótese, por: (I) lucros cessantes, danos indiretos, danos emergentes reflexos ou danos morais entre moradores, entregadores e condomínio; (II) furto, roubo, extravio, avaria, deterioração de perecíveis ou troca de encomendas físicas na portaria; (III) entregas realizadas mediante fraude de terceiros, uso indevido de Palavra-Chave/PIN ou falha de conferência humana do porteiro sobre dados lidos por OCR; (IV) perda de dados locais decorrente de formatação/provisionamento de aparelhos no Modo Portaria Exclusiva (Kiosk Android); (V) bloqueios ou atrasos de mensagens no WhatsApp/Meta ou provedores externos.

19.2. TETO GLOBAL DE INDENIZAÇÃO (CAP DE RESPONSABILIDADE): Em qualquer hipótese de responsabilidade civil ou contratual comprovadamente imputável por culpa exclusiva e direta da CONTRATADA, o valor total e acumulado de eventual indenização devida à CONTRATANTE ficará estritamente limitado ao montante total efetivamente pago pela CONTRATANTE à CONTRATADA a título de mensalidades nos 6 (seis) meses imediatamente anteriores ao evento danoso (ou ao limite máximo global de R$ 500,00 caso o evento ocorra durante o Período de Teste Gratuito ou no primeiro mês de vigência).

19.3. As Partes reconhecem que os preços acessíveis das mensalidades do software foram calculados com base na alocação de riscos e no limite de responsabilidade estabelecidos nesta Cláusula, nos termos do art. 421-A do Código Civil (Lei da Liberdade Econômica).

## CLÁUSULA 20ª – COMUNICAÇÕES E NOTIFICAÇÕES JURÍDICAS

20.1. Todas as comunicações, avisos técnicos, faturas e notificações entre as Partes serão considerados plenamente válidos quando encaminhados aos endereços de e-mail e números de WhatsApp cadastrados no preâmbulo deste contrato e no Anexo I.

## CLÁUSULA 21ª – ASSINATURA ELETRÔNICA VIA AUTENTIQUE, TÍTULO EXECUTIVO E RESPONSABILIDADE SOLIDÁRIA

21.1. VALIDADE DA ASSINATURA ELETRÔNICA (AUTENTIQUE E CLICKWRAP): As Partes celebram o presente contrato por meio eletrônico, mediante assinatura digital/eletrônica processada pela plataforma Autentique (https://autentique.com.br) e/ou aceite eletrônico autenticado na Plataforma Portaria Prime, reconhecendo sua plena validade jurídica, autoria, integridade e eficácia probatória, nos termos do art. 10, § 2º da Medida Provisória nº 2.200-2/2001 e da Lei nº 14.063/2020.

21.2. TÍTULO EXECUTIVO EXTRAJUDICIAL SEM TESTEMUNHAS (ART. 784, § 4º DO CPC): Nos termos do art. 784, § 4º do Código de Processo Civil (incluído pela Lei nº 14.620/2023), o presente contrato assinado eletronicamente constitui Título Executivo Extrajudicial líquido, certo e exigível, sendo expressamente dispensada a assinatura de testemunhas quando sua integridade for atestada pelo provedor de assinatura eletrônica (Autentique / Hash SHA-256).

21.3. DECLARAÇÃO DE PODERES E RESPONSABILIDADE PESSOAL SOLIDÁRIA: A pessoa física que preenche o cadastro e assina eletronicamente este instrumento em nome da CONTRATANTE declara, sob as penas da lei civil e criminal, ser o síndico eleito, administrador legal ou procurador com poderes bastantes para obrigar o Condomínio. Caso se verifique posteriormente que o signatário atuou sem poderes regulares de representação ou sem aprovação interna exigida pela convenção condominial, o signatário pessoa física responderá pessoal e solidariamente por todas as obrigações financeiras e contratuais assumidas neste instrumento.

## CLÁUSULA 22ª – CASO FORTUITO E FORÇA MAIOR

22.1. Nenhuma das Partes será responsabilizada pelo descumprimento de obrigações decorrente de caso fortuito ou força maior (art. 393 do Código Civil), tais como panes gerais da rede mundial de computadores, cortes de cabos submarinos, apagões elétricos, pandemias ou determinações estatais.

## CLÁUSULA 23ª – DISPOSIÇÕES GERAIS

23.1. Este contrato não estabelece qualquer vínculo societário, associativo, de franquia ou trabalhista/empregatício entre a CONTRATADA e os empregados, porteiros ou prestadores da CONTRATANTE.

23.2. A tolerância de uma Parte quanto a eventual atraso ou descumprimento da outra não importará em novação ou renúncia de direitos.

23.3. Se qualquer disposição deste contrato for considerada nula ou inexequível, as demais cláusulas permanecerão em pleno vigor.

23.4. Integram este contrato, como partes indissociáveis, o Anexo I (Quadro Comercial, Plano e SLA) e o Anexo II (Acordo de Tratamento de Dados Pessoais – DPA).

## CLÁUSULA 24ª – FORO DE ELEIÇÃO

24.1. Fica eleito o Foro Central da Comarca da Capital do Estado de São Paulo/SP para dirimir quaisquer dúvidas ou litígios oriundos deste contrato, com renúncia expressa a qualquer outro, por mais privilegiado que seja.

E, por estarem assim justas e contratadas, as Partes firmam eletronicamente o presente instrumento em via digital certificada pela plataforma Autentique, com registro de IP, carimbo de tempo (timestamp) e hash criptográfico SHA-256.

São Paulo/SP, {{DATA_EXTENSO_CONTRATO}}.

**CONTRATADA:**

59.760.458 MARCO ANTONIO BOGGIAN

CNPJ: 59.760.458/0001-91

Representante: Marco Antonio Boggian

E-mail: avisos@portariaprime.com.br

[Assinado Eletronicamente via Autentique]

**CONTRATANTE:**

{{CONDOMINIO_NOME}}

CNPJ/CPF: {{CONDOMINIO_CNPJ}}

Representante Legal: {{SINDICO_NOME}}

CPF: {{SINDICO_CPF}} | E-mail: {{SINDICO_EMAIL}}

[Assinado Eletronicamente via Autentique]

Dispensa legal de testemunhas conforme Art. 784, § 4º do Código de Processo Civil (Lei nº 14.620/2023) — Integridade e autoria certificadas eletronicamente via Autentique (ID do Documento: {{AUTENTIQUE_DOCUMENT_ID}} | Hash SHA-256: {{CONTRACT_SHA256_HASH}}).

## ANEXO I – QUADRO RESUMO COMERCIAL, ESCOPO DO PLANO E SLA

- Plataforma Licenciada: Portaria Prime (https://portariaprime.com.br)
- Condomínio Contratante: {{CONDOMINIO_NOME}} (CNPJ/CPF: {{CONDOMINIO_CNPJ}})
- Endereço do Empreendimento: {{CONDOMINIO_ENDERECO}}
- Responsável / Síndico(a): {{SINDICO_NOME}} (CPF: {{SINDICO_CPF}} | E-mail: {{SINDICO_EMAIL}} | WhatsApp: {{SINDICO_TELEFONE}})
- Plano Escolhido: {{PLANO_NOME}}
- Limite do Plano: {{PLANO_LIMITE_DESCRICAO}} (e teto técnico de até 20 dispositivos ativos no módulo Kiosk)
- Valor da Mensalidade: R$ {{PLANO_VALOR_MENSAL}} ({{PLANO_VALOR_EXTENSO}})
- Taxa de Implantação: {{TAXA_IMPLANTACAO_DESCRICAO}} (Isenta nos planos autogeridos)
- Período de Teste Gratuito (Free Trial): 30 (trinta) dias corridos gratuitos — Início em {{DATA_INICIO_TRIAL}} e término em {{DATA_FIM_TRIAL}}
- Vencimento das Mensalidades (pós-teste): Dia {{DIA_VENCIMENTO}} de cada mês, via InfinitePay (PIX, Cartão ou Link de Pagamento)
- Módulos Incluídos no Plano: Cadastro vertical/horizontal de unidades e moradores; importação de planilhas CSV/XLSX; recebimento de encomendas com OCR de etiquetas por IA e pop-up de confirmação; cadastro de entregadores com OCR de CNH; login de porteiros com verificação facial (turno de 12h); notificações a moradores; baixa por QR Code com assinatura digital, foto e comprovante PDF; palavra-chave de entrega; recusa pelo morador; gestão de morador não identificado; e acesso opcional ao Modo Portaria Exclusiva (Kiosk Android em acesso piloto para aparelhos compatíveis).
- Canais e Horário de Suporte: E-mail (avisos@portariaprime.com.br) e WhatsApp comercial oficial, de segunda a sexta-feira, das 09h às 18h (exceto feriados nacionais).
- SLA de Primeira Resposta: Incidente crítico: até 4h úteis | Incidente alto: até 1 dia útil | Solicitação comum: até 3 dias úteis.
- Disponibilidade-Alvo: 99,0% ao mês, observadas as exclusões da Cláusula 9ª.

## ANEXO II – ACORDO DE TRATAMENTO DE DADOS PESSOAIS (DPA – LGPD)

- Controladora dos Dados: CONTRATANTE ({{CONDOMINIO_NOME}}), quanto aos dados de moradores, unidades, porteiros, funcionários, prestadores e entregadores vinculados ao condomínio.
- Operadora dos Dados: CONTRATADA (59.760.458 MARCO ANTONIO BOGGIAN – Portaria Prime), quanto ao processamento tecnológico realizado em nome da CONTRATANTE.
- Categorias de Titulares: Moradores, condôminos, síndicos, administradores, porteiros, funcionários da portaria e entregadores de encomendas.
- Categorias de Dados Tratados (Autorizados pela Controladora): (1) Dados cadastrais: nome completo, bloco/quadra/rua, apartamento/lote/casa, telefone/WhatsApp e e-mail; (2) Dados de encomendas: fotos da embalagem e etiqueta, transportadora, código de rastreio, palavra-chave de recebimento, assinatura digital em tela e comprovante de retirada; (3) Dados de entregadores: nome, CPF, número e foto da CNH/documento lidos por OCR na portaria e histórico de entregas no condomínio; (4) Dados de porteiros/funcionários: nome, documento, foto e biometria facial para autenticação de turno de 12h e logs de auditoria.
- Bases Legais Aplicáveis (definidas pela Controladora): Execução de contrato e procedimentos preliminares (art. 7º, V da LGPD), legítimo interesse do condomínio e dos moradores na recepção segura de encomendas (art. 7º, IX da LGPD), cumprimento de obrigação legal/auditoria e, quanto à biometria facial de porteiros e documentos de acesso, prevenção à fraude e segurança do titular e do condomínio (art. 11, II, 'a' e 'g' da LGPD).
- Prazo de Retenção e Descarte: Durante a vigência contratual e por até 30 (trinta) dias após o encerramento para exportação pela CONTRATANTE, sendo eliminados após esse prazo, salvo dever legal de guarda ou exercício regular de direitos (art. 16 da LGPD).
- Suboperadores Autorizados: Supabase Inc. / AWS (Banco de dados e Storage criptografado), Vercel Inc. e Cloudflare Inc. (Hospedagem e segurança de borda), Google LLC (API Gemini Vision para OCR estrito sem treinamento público), Resend Inc. (E-mails transacionais), Autentique LTDA (Assinatura eletrônica de contratos) e InfinitePay / CloudWalk (Processamento de pagamentos).
- Canais de Privacidade (Encarregado / DPO): Pela CONTRATADA: avisos@portariaprime.com.br | Pela CONTRATANTE: {{SINDICO_EMAIL}}.
