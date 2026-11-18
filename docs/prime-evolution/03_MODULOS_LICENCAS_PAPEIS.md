# 03 · Módulos, licenças e papéis

## Catálogo (`module_catalog`)

| Chave | Nome | Fase | Hardware | Pode ligar hoje |
|---|---|---|---|---|
| `parcels` | Encomendas | P0 | não | sempre ligado (padrão) |
| `visitors` | Visitantes | P0 | não | sim |
| `concierge` | Portaria (central + gateway simulado) | P0 | não | sim |
| `incident` | Ocorrências | P1 | não | não (sem implementação) |
| `cctv` | Câmeras | P1 | sim | não |
| `access_control` | Controle de acesso | P2 | sim | não |
| `intercom` | Interfonia | P2 | sim | não |
| `garage` | Garagem | P2 | sim | não |
| `remote_operations` | Central remota | P3 | sim | não |
| `analytics_ai` | Inteligência | P3 | sim | não |

`available = false` impede ligar no banco: ninguém contrata o que não existe.

## Como ligar (superadmin)

`/admin` › condomínio › Detalhes › **Módulos contratados** › Ligar/Desligar, com justificativa obrigatória (5 a 300 caracteres).
- Só o papel `owner` tem `modules_manage`. Com MFA cadastrado, exige aal2 (mesma regra das demais ações da plataforma).
- **Idempotente:** repetir o mesmo estado não cria versão nem auditoria.
- **Versão e trilha:** cada mudança incrementa `version` e grava antes/depois em `tenant_module_audit`, que é append-only.
- **Vigência:** `valid_until` opcional; vencido = desligado.
- **Desligar:** não apaga dados.

## Separação comercial × segurança

- Os módulos **não** alteram plano, preço, trial nem cobrança. `app.has_feature` (OCR, WhatsApp, totem, relatórios) continua igual.
- Suspensão de módulo ou estado comercial `restricted` só impede **novos** convites (`can_operate`). Nunca aciona nem trava portas. Em P0 não existe comando físico real.
- **Encerramento comercial**, procedimento recomendado e ainda não automatizado:
  1. Desligar os módulos.
  2. Revogar os gateways no painel; isso invalida a credencial na próxima chamada.
  3. Entregar ao condomínio o export de logs e da lista de dispositivos.
  4. O hardware local segue as regras de segurança de vida dele, que não dependem da nuvem.

## Papéis (reuso dos existentes)

| Ação | Morador | Porteiro | Síndico (admin) | Superadmin |
|---|---|---|---|---|
| Ver módulos do condomínio | sim | sim | sim | sim (todos) |
| Convidar visita | só as próprias unidades | sim | sim | — |
| Registrar entrada/saída | — | sim | sim | — |
| Central da portaria | — | sim | sim | — |
| Criar/revogar gateway | — | — | com `settings` + senha recente | — |
| Pedir comando (simulado) | — | sim + senha recente | sim + senha recente | — |
| Ligar/desligar módulo | — | — | — | `owner` |

Porteiro com identidade facial continua precisando de turno aberto (`app.is_staff`), regra herdada sem mudança.
