# Permissões e papéis

## Modelo

Cada condomínio é isolado por `tenant_id NOT NULL` em todas as tabelas de negócio. FKs compostas `(tenant_id, id)` impedem referência cruzada. RLS habilitada em todas as tabelas públicas. `service_role` tem `BYPASSRLS` e é usada exclusivamente pelo backend, com filtro explícito de tenant.

## Papéis Auth

- Superadministrador Portaria Prime: somente em `platform_admins`, inserido por script controlado. Acessa overview e painel, nunca dados de encomendas e provas de terceiros automaticamente.
- Admin do condomínio: vínculo `tenant_memberships.role = 'admin'`. Permissões granulares em `permissions[]`: `team`, `approve`, `settings`, `billing`. Ausente = somente leitura operacional.
- Porteiro: `role = 'porteiro'`, operações de portaria sem gestão de equipe, planos ou configurações.
- Morador: `role = 'morador'`, acessa encomendas da própria unidade via `unit_memberships`. Vínculo por convite de uso único. Saber bloco/unidade não concede acesso.
- Totem: credencial por dispositivo pareado, revogável. Sem sessão Auth de funcionário, sem lista de moradores/telefones.

## JWT e revogação

Revogação (`set_membership_status`) vale na próxima query: helpers de autorização consultam vínculo ativo e estado comercial do tenant no banco, nunca somente o JWT. O JWT expirado ou com papel adulterado é recusado pelo helper RLS antes de qualquer dado ser devolvido. Estado `trialing`/`pending_payment`/`restricted` limita operações, não só a UI.

## RPCs sensíveis

- Escrita e leitura de encomendas, retirada, exceção, movimentação e token QR: via RPC `SECURITY DEFINER`, que valida `auth.uid()`, vínculo ativo e estado comercial.
- Cobrança: RPCs de checkout, reconciliação e ativação de pagamento somente `service_role`, nunca `authenticated`.
- Totem: `device_pair` e `device_preregister` somente `service_role`; contexto devolvido sem dados pessoais.

## Push SSRF

Endpoints Web Push aceitos somente via allowlist fechada: FCM Google, Mozilla, Apple e notify.windows.com. Restrição no banco (constraint) e na API antes do envio. Inscrições anteriores fora da lista não são enviadas.

## Auditoria

`audit_logs` é append-only por trigger. Operações manuais de suporte precisam de ação explícita, escopo e registro; não há bypass silencioso.

## Avisos e contatos

Destinatários de e-mail e WhatsApp resolvidos no servidor, nunca fornecidos pelo cliente. Revogação de morador desativa `resident_contacts`; reativação manual requer revisão. Fila revalida autorização antes de cada envio, não só no enfileiramento.

## Pendências de autorização

- Rollback de acesso quando um morador se muda: requer revogação do vínculo pelo síndico; nenhum processo automático.
- Consentimento LGPD: registrado, mas política de retenção e direitos do titular precisam de revisão jurídica e implementação de deleção auditável.
- Suporte excepcional a dados de terceiros: requer ação explícita, escopo, justificativa e auditoria — não implementados ainda.
