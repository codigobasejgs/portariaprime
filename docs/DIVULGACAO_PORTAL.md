# Central de divulgação do portal

Fica em **Configurações → Portal e aplicativo**, abaixo do link e do QR de acesso. Visível só para quem tem a permissão de alterar configurações (síndico/administração). Porteiros e moradores não veem a seção, e o servidor recusa as chamadas deles.

## O que entrega

| Modelo | Formato do arquivo | Uso |
|---|---|---|
| Cartaz A4 | PNG 1240×1754 (150 dpi) e PDF A4 | Mural, portaria e áreas comuns |
| Comunicado A4 | PNG 1240×1754 e PDF A4 | Circular com o passo a passo do cadastro |
| Elevador (A5) | PNG 874×1240 e PDF A5 | Elevador e hall |
| WhatsApp / Instagram | PNG 1080×1080 (PDF em página A4) | Grupos e redes sociais |

Cada modelo tem título, subtítulo, texto e chamada sobre o QR, todos editáveis, com prévia ao vivo. Os materiais usam o nome de exibição, a cor principal e o logo do condomínio (Identidade visual). A cor do texto sobre a faixa é escolhida pelo contraste.

Também há uma mensagem pronta com botões **Copiar mensagem**, **Copiar link** e **Enviar pelo WhatsApp** (`wa.me`). Quando o navegador permite, **Compartilhar** envia a própria imagem pelo menu de compartilhamento do aparelho.

## Segurança

- O QR e o link são sempre `https://{domínio}/c/{slug}`, que é o portal público. `assertPublicLink` recusa qualquer endereço com query, hash, credenciais, caminho diferente ou sem HTTPS. Por isso, convite, token e senha nunca entram no QR.
- O portal continua exigindo conta, termo de dados e aprovação da administração. O QR só leva até a porta de entrada.
- Os textos ficam em `public.portal_divulgacao`, sem nenhum acesso direto para usuários. Leitura e gravação passam pelas funções `divulgacao_get` e `divulgacao_save`, que exigem a permissão `settings` no condomínio informado.
- O banco valida os textos: só modelos e campos conhecidos, título até 120 caracteres, texto até 1.200, demais campos até 240, e nada de `<` ou `>`. Cada gravação fica na auditoria (`divulgacao.saved`).
- PNG e PDF são gerados no próprio aparelho. Não há envio de dados para serviços externos.

## Banco

Migration `20261103000300_portal_divulgacao.sql`: tabela `portal_divulgacao (tenant_id, model, texts, updated_by, updated_at)` e as funções `divulgacao_get` e `divulgacao_save`. Ela só acrescenta e não altera tabelas existentes. Os grants de `tenant_settings` não foram mexidos.

Rollback: `drop function public.divulgacao_save(uuid, text, jsonb), public.divulgacao_get(uuid), app.divulgacao_valid(jsonb); drop table public.portal_divulgacao;`. Com isso, os materiais voltam aos textos padrão.

## Testes

- `tests/divulgacao.test.mjs` (unidade, 6 testes): o link precisa ser público; o QR gerado é decodificado com `jsqr` e devolve exatamente o link; textos padrão e personalizados; limites; mensagem; quebra de linha; contraste.
- `tests/db/divulgacao.test.mjs` (banco): permissões de síndico, porteiro, morador, outro condomínio e visitante sem login; validação; voltar ao padrão; isolamento; tabela sem acesso direto; auditoria.
- `tests/e2e/divulgacao.mjs` (navegador real, ambiente local): passa pelos 4 modelos, edita, salva e recarrega; baixa o PNG e confere 1240×1754 com o QR lido e igual ao link público; confere que o PDF tem uma página A4; copia a mensagem e confere o link do WhatsApp; restaura o padrão; verifica que não há rolagem horizontal de 320 a 1440 px; confirma que o porteiro não vê a seção e é recusado no servidor.

## Limites conhecidos

- O logo precisa estar no armazenamento público do condomínio, que é o padrão do sistema. Se ele não carregar, o material sai sem o logo, mas com todo o resto.
- O PDF guarda a imagem do material em 150 dpi. É suficiente para impressão A4, mas o texto não é vetorial.
- O compartilhamento nativo da imagem depende do navegador. No desktop e em navegadores sem `navigator.share`, ficam disponíveis o download e o link do WhatsApp.
