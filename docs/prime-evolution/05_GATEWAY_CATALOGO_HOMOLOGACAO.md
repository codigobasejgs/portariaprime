# 05 · Gateway local, catálogo e homologação

## O que existe em P0

- **`gateway/simulator.mjs`** (Node, sem dependências).
  - Pareia por código e grava o estado com permissão 600 e escrita atômica.
  - Manda heartbeat com relógio, o que permite medir o clock drift.
  - Publica um inventário determinístico: um portão e uma câmera simulados.
  - Recebe comandos e devolve `seq` e `nonce` exatamente como chegaram.
  - Mantém uma **fila persistente** de resultados, que sobrevive a queda de rede e de processo.
  - Para de vez quando é revogado (401).
- **O simulador NUNCA:** abre porta serial, acessa a rede local, fala ONVIF/RTSP/SIP ou emite comando físico.
- **Do lado da nuvem:** `gateways`, `gateway_devices`, `access_commands` e as RPCs `gateway_*` / `access_command_request`.

```bash
# síndico cria o gateway no banco (RPC gateway_create, senha recente) e recebe o código
node gateway/simulator.mjs pair --api http://127.0.0.1:3027 --code ABCDEFGH12 --state ./gw-state.json
node gateway/simulator.mjs run  --api http://127.0.0.1:3027 --state ./gw-state.json --once [--sensor] [--offline]
```

## Por que Node e não Go em P0

Esta máquina não tem Go instalado (`go: program not found`). O valor de P0 está em fixar o contrato nuvem ↔ gateway com testes.

O agente de produção será em **Go** (P1), com:
- binário único para Linux e Windows, rodando como serviço;
- SQLCipher para a fila;
- mTLS através do broker persistente;
- atualização assinada com rollback;
- drivers por capacidade.

O simulador continua como referência do contrato e como teste de regressão.

## Interface de driver (contrato para P1/P2)

`discover` · `identify` · `listCapabilities` · `getStream` · `snapshot` · `subscribeEvents` · `requestAccessAction` · `readAccessState` · `health`.

Capacidades em `gateway_devices.capabilities`; P0 usa `pulse_open`, `read_state` e `snapshot`.

## Catálogo de homologação

`gateway_devices` tem `vendor`, `model`, `firmware`, `driver`, `capabilities`, `homologation_status` e `has_physical_sensor`.

| Estado | Significado |
|---|---|
| `simulated` | simulador, sem equipamento |
| `candidate` | modelo identificado, sem teste |
| `tested_lab` | teste em bancada com evidência |
| `tested_field` | teste no condomínio; o banco **exige** `model` e `firmware` preenchidos |
| `partial` | parte das capacidades funciona |
| `unsupported` | não funciona ou não há API legítima |

Regras P0, impostas no banco:
- O heartbeat só aceita `driver = 'simulator'`. Um driver real (`onvif`, `intelbras`…) é ignorado, como o teste confere.
- `access_command_request` recusa dispositivos que não estejam `simulated`, com a mensagem "pending_hardware".

## Situação das integrações

| Integração | Estado | Bloqueio |
|---|---|---|
| ONVIF / RTSP (câmeras, NVR, DVR) | `pending_hardware` | precisa do equipamento do piloto + agente Go + media plane (MediaMTX/go2rtc) |
| Intelbras (SDK/API) | `pending_hardware`, `pending_credentials` | modelo, firmware e SDK oficial |
| Hikvision / Dahua / Axis / Uniview | `pending_hardware` | por modelo |
| Linear HCS | `pending_hardware` | protocolo oficial + modelo físico; o manual Acesso Fácil não documenta o protocolo serial (e o PDF não está no workspace) |
| SIP / interfonia | `pending_hardware` | endpoint compatível + bridge |
| Streaming WebRTC/HLS | `pending_infra` | media plane local; a Vercel não transcodifica vídeo |

Nenhuma marca ou modelo está marcado como compatível.
