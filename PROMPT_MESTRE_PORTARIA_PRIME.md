# Portaria Prime — análise e prompt mestre para Claude Code

Preparado em 19/10/2026 com base no ZIP Villageazaleia-main(1).zip e no PDF Processo de recebimento de encomendas.pdf.

## Antes de usar

Abra a pasta extraída do projeto no Claude Code. Disponibilize este arquivo e o PDF. Cole a instrução: **“Leia PROMPT_MESTRE_PORTARIA_PRIME.md integralmente e execute o PROMPT MESTRE abaixo no projeto aberto, implementando as etapas e validando os critérios de aceite.”**

Este documento especifica uma implementação completa; não significa que o sistema já foi alterado, conectado ou publicado. A análise é estática: foram examinados estrutura, modelos, SQL, autenticação, serviços, endpoints e fluxos centrais. Não houve execução contra banco, envio real de mensagens ou homologação de pagamentos. Comentários de auditoria e testes presentes no ZIP não são prova de que a versão atual funciona.

## Diagnóstico do material recebido

### O que existe e merece ser preservado

- React 19 + TypeScript + Vite + Tailwind, componentes Lucide/Motion, Supabase e funções em `api/`.
- Telas de portaria, síndico, morador e totem; cadastro de moradores; fluxo de recebimento e leitura de etiquetas com Gemini/OCR.
- Identificação de unidade, transportadora, rastreio, foto e local de armazenamento; mapa de ocupação e sugestão de prateleira.
- QR Code para retirada, coleta de assinatura, foto opcional de entrega, protocolo/comprovante e histórico.
- Dashboard, filtros, exportação CSV, registro de exceções e movimentação.
- Integrações em código com Evolution API e Resend; PWA com manifesto e service worker gerado.
- SQL em `supabase/schema.sql` e quatro arquivos em `supabase/migrations/`, além de scripts de backup e testes.

### Banco perdido: o que é possível afirmar

Existe material para reconstruir o **esquema**. Não foi identificado no inventário do projeto extraído um backup dos registros históricos. O script de backup não é um backup pronto. Reconstruir tabelas não recupera automaticamente moradores, usuários Auth, encomendas, imagens e assinaturas antigas. Isso depende de backups/exportações, arquivos Storage ou acesso recuperável ao projeto anterior.

Há um ZIP interno, `village-azaleia-smart-delivery.zip`, com uma versão de código anterior. Ele não deve substituir automaticamente o código externo nem ser tratado como dump do banco.

### Problemas concretos que o prompt obriga a corrigir

| Área | Evidência no código | Consequência / ação necessária |
|---|---|---|
| Multi-tenant | Tabelas e helpers de papel sem `tenant_id`; consultas globais em `db.service.ts` | Redesenhar escopo, RLS, RPCs, índices, APIs e Storage antes de cadastrar clientes reais |
| SQL divergente | Migração inicial tem políticas públicas; schema posterior usa Auth/RLS; migração contém ajuste nominal de morador | Criar cadeia canônica, testar do zero e remover dependência de correções pessoais |
| Unidades | IDs derivados de bloco/apartamento, unicidade global; apartamento numérico | Usar UUID e unicidade por condomínio; aceitar casa, sala e unidade alfanumérica |
| Cadastro de morador | `api/units/claim.ts` associa conta a bloco/apartamento e confirma e-mail administrativamente | Exigir convite/aprovação e verificação; informar endereço não comprova vínculo |
| Totem | `api/totem/session.ts` entrega tokens sem autenticar o chamador | Parear dispositivo, limitar permissões e eliminar emissão pública de sessão privilegiada |
| Conta desativada | `api/_lib/auth.ts` não consulta `active`; `auth.service.ts` também não o verifica na busca do perfil | Validar vínculo ativo no servidor e RLS a cada ação |
| Storage | SQL fecha bucket, mas `storage.service.ts` usa `getPublicUrl`; políticas abrangem autenticados | URLs assinadas e autorização por condomínio/unidade; eliminar fallback de sucesso com base64 |
| Push | `web-push.ts` chama `new Notification()` no navegador | Não é entrega remota ao dispositivo do morador; implementar Push API + VAPID + worker |
| Mensagens | Envio depende do navegador; APIs aceitam destinatário/texto/HTML do cliente | Usar eventos persistidos, fila, templates e destinatários resolvidos no servidor |
| Auditoria | Há RPCs de baixa atômica, mas entrada/log/disparo são etapas separadas | Operações transacionais com outbox e auditoria confiável |
| Ocupação | Alocador conta apenas `ARMAZENADA`; dashboard considera tudo que não foi retirado | Unificar estados que ocupam espaço; excluir exceções e tratar lotação sem retornar A1 silenciosamente |
| Configuração | URL antiga do Supabase, marca, instância Evolution, remetentes, tipos de estante e cache fixos | Configurar por ambiente/condomínio e substituir identidade global |
| Backup | Script exporta lista antiga, inclui `staff_accounts`, não cobre Auth/Storage nem paginação explícita | Backup completo, verificável e com restauração ensaiada |
| Comercial | Não há estrutura SaaS de planos/assinaturas/cobranças no inventário | Criar administração global, onboarding e faturamento |

### Processo do PDF

O PDF é um infográfico de uma página. Descreve seis etapas: entrega pelo entregador; conferência na portaria; armazenamento; aviso ao morador; retirada com QR Code; relatórios e controle. Usa como exemplo 360 unidades, uma portaria e média de 80 encomendas/dia. Esses números devem virar cenário de demonstração/teste, nunca limites fixos do produto.

O material cita WhatsApp, notificação no app, e-mail e SMS opcional; também leitor de códigos, impressora térmica e câmeras opcionais. O projeto tem fluxo de totem, não comprovação de um app independente de entregadores. SMS, integração com CFTV e impressão térmica especializada não devem ser anunciados como entregues sem implementação e teste. Assinatura desenhada em tela não deve ser anunciada como assinatura certificada.

---

# PROMPT MESTRE — EXECUTAR NO CLAUDE CODE

Você é responsável por evoluir este projeto existente para **Portaria Prime**, um SaaS brasileiro de gestão de encomendas para vários condomínios. Atue como engenheiro full stack, arquiteto de banco, designer de produto e QA. Implemente código real, banco reproduzível, integração de cobrança e testes. Não entregue somente um plano, protótipo ou telas com botões sem ação.

## 1. Objetivo e modo de execução

O sistema era exclusivo do Village Azaleia e perdeu o banco. Agora deve atender múltiplos condomínios independentes, com landing page comercial, contratação de planos, administração global, portal do condomínio, portaria, morador e totem. Cada condomínio personaliza logo e paleta. Os condomínios pagam pelo software através da **InfinitePay brasileira, da CloudWalk, domínio infinitepay.io**. Não confundir com serviços de nome parecido.

Trabalhe até concluir tudo que o ambiente permite. Divida internamente em etapas e registre progresso em `docs/IMPLEMENTACAO_STATUS.md`; não pare após cada etapa para solicitar autorização rotineira. Não afirme funcionamento de integração não testada. Se faltar credencial, termine implementação, testes locais e documentação, e liste a variável exata e a ação externa pendente. Nunca invente dados de conexão ou use mocks silenciosamente em produção.

Antes de editar: leia AGENTS.md se existir; verifique git status e preserve alterações do usuário; faça branch de trabalho/checkpoint quando possível; inventarie módulos, APIs e migrations. Não faça reset, force push, exclusão do projeto ou migração destrutiva de banco existente. Publicação, cobrança real e envio para clientes reais exigem instrução específica; implemente e valide local/homologação primeiro.

Preserve os recursos úteis já existentes. Não reescreva tudo em outro framework por preferência. Mantenha React/TypeScript/Vite, Supabase Auth/Postgres/Storage/Realtime e deployment compatível com Vercel. Valide o contrato real do runtime das funções `api/` e configure execução local e produção corretamente: `vite build` sozinho não prova funcionamento das APIs. Escolha um gerenciador de pacotes e mantenha lockfile consistente.

## 2. Reconstrução do banco e recuperação possível

1. Examine `schema.sql`, todas as migrations, serviços, tipos, scripts e ZIP interno separadamente. Produza mapa de divergências. Não execute todos os SQLs antigos às cegas.
2. Investigue somente fontes disponíveis/autorizadas de recuperação. Diferencie: estrutura reconstruída; registros importados de backup real; dados fictícios de demonstração. Nunca chamar seed de recuperação.
3. Construa migrations versionadas e ordenadas que criem o banco novo completo, incluindo RLS, funções, índices, gatilhos, Storage, jobs e permissões. Se houver ambiente existente, produza caminho incremental separado com backup e validação. Arquive migrations obsoletas fora da cadeia executável, sem perder histórico do que foi alterado.
4. Remova ajustes por nomes de moradores e referências fixas ao apartamento/condomínio anterior. Não recrie `staff_accounts` com senhas próprias; use Supabase Auth.
5. Entregue seed de desenvolvimento com dois condomínios fictícios, mesmos bloco/unidade em ambos, papéis distintos e encomendas em todos os estados. Seed explicitamente proibido em produção sem parâmetro deliberado; sem senhas padrão publicadas.
6. Bootstrap do superadministrador por script de uso controlado e identidade verificada. Clientes jamais escolhem papel global no cadastro. Criação de conta, vínculo e condomínio deve ser idempotente, com compensação segura para falha parcial do Auth.
7. Configuração ausente deve produzir erro claro, sem fallback para URL antiga. `.env.example` somente com placeholders.
8. Backup paginado de tabelas, schema, objetos Storage e inventário Auth conforme recursos suportados. Cópia externa criptografada, retenção configurável, alertas de falha, checksums/contagens e restauração em ambiente isolado. Documente limitações de recuperação de senhas/sessões e reset de acesso quando necessário. Não salve backups no git.

## 3. Arquitetura multi-tenant obrigatória

Cada condomínio é um tenant com UUID imutável e slug único. O mesmo usuário pode ter vínculos em mais de um condomínio; papel e acesso são definidos pelo vínculo, não por um único `profiles.role` global.

Modelo mínimo, adaptando nomes de forma consistente:

- `tenants`: nome, slug, identificação/cadastro, contato, timezone, estado e datas.
- `profiles`: identidade do usuário Auth, sem autoridade global editável pelo próprio usuário.
- `tenant_memberships`: usuário, tenant, papel, situação e convite/aprovação.
- `platform_admins`: privilégio global protegido, administrado somente no servidor.
- `units`, `unit_memberships`, `resident_contacts`: unidades e moradores, inclusive vários familiares por unidade; contatos e preferências por pessoa. Unidade é texto, suporta 101A, casa 12, sala 02; bloco/torre opcional.
- `concierge_locations`, `storage_locations`: portarias, estantes, níveis, capacidade e situação configuráveis.
- `packages`, `package_events`, `package_attachments`, `pickup_tokens`, `receipts`: operação e provas de retirada.
- `tenant_branding`, `tenant_settings`, `tenant_integrations`, `device_enrollments`.
- `notifications`, `notification_recipients`, `push_subscriptions`, `notification_jobs`, `notification_attempts`.
- `plans`, `plan_prices`, `plan_entitlements`, `subscriptions`, `billing_orders`, `payments`, `payment_events`, `usage_counters`.
- `audit_logs`, `consent_records`, `invitations`.

Todos os dados de negócio têm `tenant_id NOT NULL`. FKs compostas `(tenant_id, resource_id)` impedem vincular encomenda de A à unidade/local de B. Índices começam pelo tenant quando adequado. Unicidade de unidade e de rastreio ativo é por condomínio. Tabelas globais de catálogo e identidade devem ter exceção explícita e políticas próprias.

RLS em todas as tabelas expostas, inclusive notificações, cobrança e integrações. Testar SELECT/INSERT/UPDATE/DELETE e RPC diretamente, sem depender de esconder botões. `USING` e `WITH CHECK` devem impedir mudar tenant, papel, proprietário ou período pago. Funções SECURITY DEFINER: `search_path` seguro, verificação explícita de vínculo ativo/tenant, privilégios mínimos e revogação de EXECUTE público quando necessário. Não confiar em metadados editáveis do usuário.

Middleware resolve JWT válido, tenant solicitado, vínculo ativo, papel e entitlement antes de agir. Slug, header ou `tenant_id` recebido são apenas seleção, nunca autorização. Service role fica exclusivamente no backend; toda operação com ela precisa de filtro e validação de tenant explícitos. Suspensão/revogação deve valer mesmo com JWT ainda não expirado.

Realtime com escopo e RLS; uploads, downloads, relatórios, jobs, logs, assinaturas push e cache seguem o mesmo isolamento. Cancelar subscriptions e limpar estado/cache ao trocar condomínio ou sair. Não persistir provas, QR de retirada ou dados pessoais em cache compartilhado/localStorage.

## 4. Papéis e áreas

| Papel | Permissões principais |
|---|---|
| Superadministrador Portaria Prime | Condomínios, planos/preços, pagamentos, estados comerciais, integrações globais, saúde e auditoria da plataforma |
| Administrador do condomínio / síndico | Configurar seu tenant, marca, equipe, convites, unidades, moradores, locais, relatórios, integrações permitidas e assinatura |
| Porteiro | Receber, localizar, armazenar, movimentar, notificar e entregar encomendas do seu condomínio |
| Morador | Próprio cadastro autorizado, encomendas das suas unidades vinculadas, QR, comprovantes, preferências e notificações |
| Totem | Sessão de dispositivo pareado, pré-registro restrito, sem acesso à lista de dados pessoais e sem baixa privilegiada |

Permissões sensíveis devem ser separadas, por exemplo administrar equipe, aprovar vínculos e gerenciar faturamento. Não conceder ao porteiro poderes de administração por ser “staff”. Suporte global não deve expor automaticamente fotos, assinaturas e dados pessoais; eventual acesso excepcional exige ação explícita, escopo e auditoria.

Rotas sugeridas: `/`, `/planos`, `/entrar`, `/cadastro`, `/checkout/retorno`, `/admin`, `/c/:slug`, `/c/:slug/portaria`, `/c/:slug/morador`, `/c/:slug/totem`, `/c/:slug/configuracoes`, `/c/:slug/assinatura`. Proteja rotas e APIs; mantenha redirecionamentos antigos úteis sem escolher tenant arbitrariamente.

## 5. Cadastro, acesso e onboarding

Fluxo comercial: escolher plano/ciclo → criar/verificar conta → cadastrar condomínio → criar pedido no servidor → checkout → verificar pagamento → ativar acesso → onboarding. Antes do pagamento, permitir apenas configuração inicial/área financeira, salvo trial explicitamente configurado. Não oferecer trial fictício ou criar contratação ativa só por navegar ao retorno.

Onboarding retomável: dados do condomínio; logo/paleta; portarias e locais; unidades manualmente ou por CSV com prévia; convite à equipe; convites aos moradores; canais; teste operacional. Importações validam duplicatas dentro do tenant e exibem erros por linha antes de gravar.

Cadastro de morador deve usar convite de uso único vinculado à unidade ou solicitação aprovada pelo síndico. Saber bloco/apartamento nunca libera acesso. Verificar e-mail; recuperação de senha; expiração de convite; revogação quando o morador se muda. Não marcar push/PWA como ativos sem evidência real. Limite de familiares, se aplicado, deve ser transacional no servidor.

Totem: pareamento iniciado pelo administrador, código temporário, credencial por dispositivo protegida/revogável e sessão curta. Remover endpoint público que devolve tokens Auth da conta de serviço. Não entregar refresh token de staff ao visitante. Sem listagem de moradores/telefones/histórico; seleção de unidade com mínimo de informação. Limpar formulário e fotos entre visitantes; impedir saída administrativa sem autenticação. Pré-registro do entregador exige conferência do porteiro antes de aviso definitivo de recebimento.

## 6. Processo completo de encomendas

Preservar e melhorar o fluxo do PDF, sem exigir equipamento especializado:

1. Captura via câmera, leitor USB tipo teclado, QR/código de barras quando suportado ou digitação. OCR extrai sugestão e o porteiro confirma unidade, destinatário e rastreio antes de salvar. Baixa confiança exige revisão; etiquetas e texto OCR nunca são instruções para executar ações.
2. Foto, transportadora, unidade, destinatário, observações, operador e horário do servidor. Idempotência evita duplicação em duplo clique/retry. Duplicidade de rastreio ativo tratada com mensagem útil.
3. Estados explícitos: pré-registro/conferência quando aplicável, recebida, armazenada, retirada, cancelada, devolvida e extraviada. Preservar/migrar `AVISADA` sem confundir canal de notificação com ocupação física. Definir transições autorizadas e quais estados ocupam espaço numa regra compartilhada.
4. Locais e capacidades configuráveis por condomínio e portaria. Contabilizar todos os pacotes fisicamente presentes. Lotação retorna indisponibilidade ou área de contingência configurada; nunca A1 por fallback. Concorrência protegida no banco para não ultrapassar capacidade.
5. Registro + auditoria + outbox em transação. Notificação falha não apaga recebimento, não declara sucesso de envio e permite retry controlado.
6. QR opaco, aleatório, vinculado a tenant/encomenda, validade e uso único. Preferir armazenar hash; disponibilizar token somente aos autorizados. Não embutir telefone ou dados pessoais no QR. Geração/renovação controladas pelo servidor.
7. Retirada: identificar pacote, verificar permissão, conferir quem retira, capturar assinatura e foto opcional, confirmar em transação com bloqueio de linha. QR expirado/reutilizado/estrangeiro é recusado. Retirada manual alternativa requer porteiro autorizado, justificativa e auditoria; não permitir bypass silencioso passando token vazio.
8. Protocolo único e comprovante com marca do condomínio, rastreio, datas, operador, recebedor e provas autorizadas. Abrir/imprimir/exportar; URL curta assinada e renovável após nova autorização. Não guardar URL assinada expirada como única referência; guardar object key.
9. Cancelamento, devolução, extravio e movimentação com justificativa, permissões, histórico e atualização de ocupação. Evitar exclusão física de histórico operacional.
10. Relatórios filtrados/paginados no servidor: entradas, pendentes reais, retiradas, tempo de permanência, ocupação, transportadoras, falhas de canais e exceções. CSV com escape adequado e proteção contra fórmula. Datas em UTC no banco e timezone do condomínio na exibição/filtros.

## 7. Marca e personalização

Marca global **Portaria Prime**, assinatura sugerida “Gestão de encomendas para uma portaria mais organizada”. Identidade já criada e entregue no kit `portaria-prime-brand`: azul meia-noite `#101F30`, champagne `#C8AB78`, porcelana `#F7F5F0`, ardósia `#526174`, verde patrimônio `#126B61` e tinta `#18283A`. Usar os SVGs vetoriais fornecidos, PNGs transparentes e ícones; não redesenhar o logo. Ler `GUIA_IDENTIDADE.md` e importar `design/tokens.css`. O símbolo é um portal envolvendo P; usar versão principal em fundo claro e negativa em fundo escuro. Assinatura: “Cada encomenda. Tudo sob controle.” Não manter brasão antigo como marca global. Não usar champagne como texto pequeno em fundo claro.

Cada síndico pode alterar logo, nome de exibição, cores primária/secundária/destaque e tema claro/escuro, com prévia, salvar e restaurar padrão. Aplicar tokens CSS às telas, totem, login do condomínio, comprovantes e templates de mensagens. Verificar contraste e indicar combinação ilegível. Upload com limite/tipo real e sanitização; não aceitar SVG com scripts, CSS/HTML arbitrários ou URL externa livre para injetar conteúdo.

Landing, preços e checkout conservam a marca Portaria Prime. Tenant pode exibir “Tecnologia Portaria Prime” discretamente. Personalização não altera planos, permissões ou destinatário financeiro. Remover marca antiga de títulos, textos, manifest, e-mails, recibos, README, ícones e metadados; preservar identificadores históricos quando renomear quebraria dados e documentar migração.

## 8. Landing page comercial

Construir página pública completa, mobile primeiro, rápida, acessível e com aparência de produto profissional. Sem fundo que prejudique leitura, excesso de animações, imagens genéricas irrelevantes ou indicadores inventados.

Seções: hero “Receba, organize e entregue encomendas com mais controle”; CTAs “Conhecer os planos” e “Entrar no sistema”; problema/benefícios; seis etapas do processo; telas reais com dados fictícios identificados como demonstração; portaria/morador/síndico/totem; OCR com revisão humana; rastreabilidade/QR/comprovantes; personalização; planos comparáveis; FAQ; contato configurável; rodapé com termos e privacidade.

FAQ: instalação, equipamentos, vários moradores, personalização, falha de internet, troca de plano, pagamento, aprovação de cadastro e suporte. Informar limites de notificações conforme navegador e configuração. Não prometer SMS, CFTV, envio ilimitado, disponibilidade absoluta ou certificação LGPD. Não criar depoimentos, números de clientes, telefone, endereço ou CNPJ fictícios apresentados como reais. Conteúdo jurídico deve ser minuta para revisão, sem bloquear a implementação técnica.

CTAs funcionais. Se contato não foi configurado, mostrar formulário com persistência e controle de spam; não gerar WhatsApp para número inventado. SEO básico, Open Graph, headings, sitemap e metadados coerentes; áreas privadas fora do índice.

## 9. Planos e preços configuráveis

Criar catálogo editável pelo superadministrador. Valores abaixo são **hipóteses comerciais iniciais do projeto**, não pesquisa de mercado nem preços já aprovados. Usar como seed em ambiente de demonstração; no ambiente real deixar revisão/publicação explícita no painel antes de aceitar compras.

| Plano | Mensal | Trimestral (total) | Anual (total) | Unidades | Portarias |
|---|---:|---:|---:|---:|---:|
| Essencial | R$ 99 | R$ 282 | R$ 990 | 80 | 1 |
| Profissional | R$ 199 | R$ 567 | R$ 1.990 | 250 | 2 |
| Prime | R$ 349 | R$ 995 | R$ 3.490 | 600 | 4 |
| Sob medida | Consulta | Consulta | Consulta | Configurável | Configurável |

Todos incluem gestão básica, QR, comprovantes, moradores, equipe, personalização, notificações no app e relatórios básicos. Profissional/Prime podem habilitar OCR, WhatsApp, totem e relatórios ampliados; registrar matriz exata em banco e frontend. Nunca cobrar separadamente de moradores por padrão. Não prometer custo ilimitado de IA, Storage ou mensagens: definir franquias editáveis de OCR/WhatsApp/armazenamento, contadores atômicos e avisos. Sem excedente cobrado automaticamente sem contratação explícita. Esgotamento do OCR oferece digitação manual.

Preço em centavos inteiros, moeda BRL. Mostrar valor total do ciclo e equivalente mensal com clareza. Versionar preços; pedidos e períodos contratados guardam snapshot. Alteração de catálogo não muda fatura aberta ou período já pago. Downgrade somente no próximo ciclo e quando uso permitir; upgrade inicial pode ser agendado para próximo ciclo para evitar pró-rata improvisado. Painel mostra data efetiva. Redução de limite não apaga moradores nem encomendas existentes.

## 10. InfinitePay: cobrança real e segura

Consultar novamente documentação oficial antes de codificar e salvar contrato verificado em `docs/INFINITEPAY.md`, com data, endpoints, campos, exemplos sanitizados e limitações. Referência: https://www.infinitepay.io/checkout-documentacao . Verificação preliminar em 19/10/2026: criação de links em `POST https://api.checkout.infinitepay.io/links`, consulta em `POST https://api.checkout.infinitepay.io/payment_check`, identificação da conta por `handle` (InfiniteTag sem `$`), itens em centavos, `order_nsu`, `redirect_url` e `webhook_url`. Conferir contrato atual, inclusive diferenças entre `invoice_slug` no webhook e `slug` na consulta. Não inventar API key, assinatura HMAC ou endpoint de recorrência.

A conta recebedora é **a da Portaria Prime**, que vende o software aos condomínios. Clientes não devem configurar sua própria conta recebedora para pagar a plataforma. Variável/configuração global `INFINITEPAY_HANDLE`; URLs derivadas de `APP_URL` confiável. Não aceitar handle, preço, desconto, retorno arbitrário ou período pago vindos do navegador.

Implementar:

- `POST /api/billing/checkout`: autentica administrador do tenant, valida plano publicado/ciclo/entitlements, calcula total no servidor, grava pedido pendente com snapshot e identificador único, solicita link e persiste resposta. Idempotência e tratamento de timeout ambíguo; retries não criam períodos ou pedidos duplicados.
- `GET /api/billing/orders/:id`: somente comprador/gestor autorizado do tenant, resposta mínima e sanitizada.
- `POST /api/billing/reconcile`: autorizado/rate limited, consulta verificada ao provedor, sem confiar nos parâmetros do browser.
- `POST /api/webhooks/infinitepay`: limite de tamanho e schema; grava evento duravelmente antes de processar; deduplica; processador verifica o pedido e confirma pagamento no servidor com o provedor. Se o contrato atual não documentar autenticação criptográfica do webhook, tratá-lo como aviso não confiável e exigir consulta independente antes de ativar. Não simular assinatura de segurança.
- Página de retorno mostra “Verificando pagamento”, “Confirmado”, “Pendente” ou erro recuperável; query string e comprovante anexado não ativam assinatura.

Validar associação pedido/tenant/plano/conta e valor esperado. Diferenciar valor-base `amount` de `paid_amount`, que pode incluir encargos; documentar regra conforme contrato. Não rejeitar pagamento legítimo apenas porque valor pago inclui taxa, nem aceitar pagamento inferior ao pedido. `transaction_nsu` único; pedidos desconhecidos/divergentes vão para revisão sem ativação.

Atualização de pedido, pagamento e período contratado é atômica e idempotente. Webhook repetido, atrasado ou fora de ordem não estende acesso duas vezes nem reabre pedido cancelado automaticamente. Revalidar regra para pagamento tardio e duas tentativas pagas; gerar ocorrência financeira em vez de duplicar benefício. Persistir IDs para reconciliação e nunca registrar dados de cartão.

Assinatura: estados `pending_payment`, `active`, `past_due`, `suspended`, `canceled`, e `trialing` somente se habilitado. Períodos por calendário com regra explícita para fim de mês/timezone; data final exclusiva. Renovação antecipada começa no fim do período vigente; renovação após expiração segue política documentada. Cancelamento interrompe próximas cobranças e preserva acesso já pago até o fim, salvo caso administrativo documentado.

**Recorrência:** a API pública de checkout consultada não demonstra, por si só, um contrato de débito automático recorrente. Implementar geração periódica de pedido/link, lembretes e pagamento pelo condomínio. Chamar de “renovação com pagamento por link”. Somente ativar débito automático se documentação/API oficial e capacidade da conta o suportarem, com consentimento e testes. Parcelamento de compra anual não é recorrência mensal. Não trocar silenciosamente a InfinitePay por outro provedor.

Job confiável e autenticado para vencimento, lembretes e reconciliação, com locks/idempotência; sem depender de navegador aberto. Se a consulta exige IDs ainda não recebidos, manter pendente e oferecer reprocessamento/revisão, sem inventar busca por `order_nsu` não documentada. Tratamento de estorno/contestação: automatizar somente os eventos documentados; caso contrário revisão administrativa auditada, sem endpoint fictício.

Inadimplência: carência configurável com padrão inicial de sete dias; avisos ao gestor. Após carência, restringir novos recebimentos e funções pagas, mantendo cobrança, exportação, consulta e retirada segura de encomendas já guardadas para equipe autorizada. Aplicar a mesma política no backend/RLS/RPC, não somente UI. Nunca apagar dados por atraso.

## 11. Notificações e integrações existentes

Preservar Evolution API, Resend e Gemini, removendo instância/remetente/marca fixos. Validar documentação oficial da versão efetivamente usada. Configuração por tenant quando necessário; chaves criptografadas e somente backend, respostas mascaradas. Não criar endpoint que faça requisição a qualquer URL informada: validação/allowlist e proteção SSRF.

Mensagem deve nascer de evento persistido: recebimento confirmado, retirada, falha/reenvio, convite, cobrança e renovação. Templates escapam texto; destinatários são resolvidos pelo servidor com vínculos e preferências, não HTML/telefone livres do frontend. Fila/outbox, retry com backoff, deduplicação por evento/canal/destinatário, histórico e limite por tenant. Status distinguem fila, aceito pelo provedor, entregue quando confirmado, falhou e desabilitado. Não usar `SIMULATED` como sucesso em produção. WhatsApp de operação deve priorizar chegada/retirada; lembretes adicionais configuráveis para evitar spam.

Web Push real: PushManager, inscrição endpoint/p256dh/auth por usuário/dispositivo/tenant, chave VAPID pública no frontend e privada no servidor, envio backend, service worker com `push` e `notificationclick`, revogação e remoção de endpoints inválidos. Não substituir por `new Notification()` na tela do porteiro. Abrir link exige sessão e autorização. Preferir texto discreto na tela bloqueada. Notificações internas e estado de leitura por usuário no banco.

OCR via backend; limites de imagem/tipo e custo por tenant; modelo configurável e suportado; revisão humana; logs sem etiquetas completas ou segredos. Falha do OCR não impede entrada manual. Falha de mensagens não desfaz operação física registrada.

## 12. PWA, experiência e segurança dos arquivos

Responsivo em 360, 390, 768, 1024 e 1440 px, tablet horizontal/vertical e desktop; alvos de toque adequados, teclado, foco, contraste, formulários com mensagens simples. Porteiro deve encontrar Receber/Entregar/Buscar em destaque; evitar dashboards poluídos. Temas claro/escuro e loading/empty/error/offline em todos os fluxos.

PWA Portaria Prime instalável onde suportado, ícones corretos, update seguro, HTTPS e orientação de instalação por plataforma. Personalização dentro do app é obrigatória; se implementar manifest por tenant, usar identidade/start_url/scope coerentes e validar isolamento. Não prometer que logo/nome do ícone já instalado mudam instantaneamente. Sem cache de respostas financeiras, tokens, URLs assinadas e dados pessoais entre usuários. Offline mostra indisponibilidade; não confirmar retirada, pagamento ou registro como concluídos sem servidor. Testar permissões de câmera/notificação negadas e oferecer alternativa manual.

Fotos/assinaturas/comprovantes em bucket privado com caminhos `tenant_id/...`, regras por papel e vínculo. Logos públicos apenas em bucket/rota separados de mídia privada. URLs assinadas curtas, MIME real, tamanho máximo e nomes gerados. Upload falhou = erro/retry explícito. Anexos órfãos têm limpeza controlada. Auditoria sem tokens/senhas nem cópia desnecessária de dados pessoais; retenção configurável e trilha de operações administrativas. Não afirmar conformidade legal automática.

Central de ajuda pesquisável, FAQ e tour curto por papel, com seletores estáveis, opção pular/recomeçar, sem modificar dados reais durante tutorial. Orientações para receber, corrigir OCR, armazenar, avisar, entregar, administrar moradores, personalizar e pagar assinatura.

## 13. QA obrigatório e critérios de aceite

Criar e executar testes úteis unitários, integração SQL/RLS e E2E. As suítes antigas são referência; não rodá-las contra produção nem confiar nos comentários de sucesso. Evidência de testes com usuários comuns, não somente service role.

1. Banco limpo sobe por migrations e seed isolado; reaplicação pelo mecanismo de migrations não duplica dados. Restore de backup ensaiado com contagens e objetos.
2. Tenant A e B usam mesmo bloco/unidade/rastreio sem colisão. Usuário A não lê/grava dados B por API direta, PostgREST, RPC, Storage, URL assinada, Realtime, exportação, cobrança ou troca manual de slug/ID.
3. Morador não se promove, muda vínculo ou entra em outra unidade sabendo endereço. Convite expirado/reutilizado e cadastro não aprovado são recusados. Desativação revoga ações existentes.
4. Totem não pareado é negado; pareado não lista dados pessoais nem confirma retirada. Revogação funciona.
5. Recebimento/OCR/manual/foto/armazenamento/aviso/retirada/assinatura/comprovante funcionam ponta a ponta e persistem após reload.
6. Dois porteiros tentam mesma retirada: exatamente uma vence. QR inválido, expirado, reutilizado e de outro tenant falham. Retry de entrada não duplica pacote. Local lotado e corrida pela última vaga tratados.
7. Estados de ocupação e relatórios coincidem; cancelada/devolvida/extraviada não contam indevidamente como pendentes. Filtros respeitam timezone; paginação não perde registros.
8. Falha de upload, rede, banco, OCR ou canal não aparece como sucesso. Fila retoma após fechar navegador. Push remoto testado em dispositivos disponíveis; compatibilidade não testada explicitamente indicada.
9. Preço adulterado no browser ignorado. Retorno falso e webhook forjado não ativam. Evento duplicado/fora de ordem, valor divergente, timeout, pagamento tardio, pedido desconhecido e tenant incorreto tratados. Renovação não estende duas vezes. Bloqueio comercial não impede retirar pacote já recebido.
10. Personalização de A não muda B, landing ou recebimento financeiro. Login/troca de tenant/logout não vazam tema nem dados anteriores. PWA e câmeras têm fallback.
11. Build e verificação TypeScript passam; APIs testadas no runtime correto; sem segredos no bundle, source maps publicados ou logs. Testes de autorização verificam ausência de efeito no banco, não só HTTP esperado.
12. Jornada de síndico iniciante: contratar, confirmar acesso, personalizar, cadastrar unidade, convidar porteiro/morador, receber e entregar. Jornada sem assistência deve ter rótulos e erros compreensíveis.

Sem credenciais externas, rodar mocks somente nos testes, explicitamente identificados. Separar “passou local”, “homologado externamente”, “não testado” e “bloqueado”. Não escrever “100% pronto” se pagamento, RLS, restore ou fluxos essenciais não foram verificados.

## 14. Entregáveis e fechamento

Entregar no repositório:

- Código completo da landing, administração global, gestão por tenant, morador, portaria, totem, personalização e cobrança.
- Migrations canônicas, seed de demonstração, scripts de bootstrap/importação/backup/restore e política de rollback.
- `.env.example` limpo: Supabase público/servidor, service role somente servidor, `APP_URL`, `INFINITEPAY_HANDLE`, Resend, Evolution, Gemini, VAPID e segredo do job conforme implementação efetiva. Não exigir variáveis inventadas e explicar onde cada uma é obtida.
- `docs/DIAGNOSTICO_LEGADO.md`, `ARQUITETURA_MULTITENANT.md`, `BANCO_E_RESTAURACAO.md`, `PERMISSOES.md`, `INFINITEPAY.md`, `DEPLOY.md`, `OPERACAO_E_BACKUP.md`, `QA_RESULTADOS.md`, `IMPLEMENTACAO_STATUS.md`.
- Testes e evidências, incluindo screenshots com dados fictícios nos tamanhos principais e matriz requisito → implementação → teste → pendência.
- Instruções exatas para novo Supabase, Auth URLs, buckets/RLS, variáveis, runtime Vercel, webhook e scheduler. Sem publicar ou movimentar dinheiro real por conta própria.

Ordem de execução: diagnóstico/checkpoint → schema multi-tenant/autorização → fluxos operacionais seguros → branding/personalização → planos/cobrança → landing/onboarding → canais/PWA/ajuda → QA/restore/documentação. Atualizar checklist e prosseguir até o fim; ao faltar insumo externo, concluir as partes independentes.

No relatório final diga: o que mudou; o que foi preservado; o que foi testado; qual banco foi reconstruído; se algum dado histórico foi realmente recuperado; quais integrações estão comprovadas; e quais credenciais/ações externas ainda faltam. Não encerrar apenas dizendo que a arquitetura está planejada. **Comece pela inspeção do projeto e implemente.**

---

## Fontes externas para a implementação

- InfinitePay, documentação oficial de Checkout, consultada em 19/10/2026: https://www.infinitepay.io/checkout-documentacao
- Centro de ajuda oficial, Checkout Integrado: https://ajuda.infinitepay.io/pt-BR/articles/10766888-como-usar-o-checkout-integrado-da-infinitepay

As decisões de arquitetura, política de acesso e preços sugeridos deste documento são propostas para este projeto. Confirmar contratos técnicos atuais antes da integração; não confundir documentação de checkout com disponibilidade de API pública de débito recorrente.
