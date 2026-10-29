# Integração Efí Bank — API PIX com mTLS

O adaptador está em `src/payment-providers/efi.ts`. Implementa OAuth, cobrança
imediata com referência estável, consulta canônica, código PIX/QR e os métodos
opcionais de consulta de recebimento/devolução. A integração **ainda não foi
validada na homologação nem em produção da Efí**: faltam credenciais e certificado.

## Fontes oficiais consultadas

Contratos conferidos no SDK oficial Efí, commit
`d742ee94b76097383c42792494351a68568e23a9`, publicado como `sdk-node-apis-efi@2.0.1`:

- [README do SDK e exemplo mínimo sem dados do devedor](https://github.com/efipay/sdk-node-apis-efi/blob/d742ee94b76097383c42792494351a68568e23a9/README.md).
- [Hosts e rotas oficiais](https://github.com/efipay/sdk-node-apis-efi/blob/d742ee94b76097383c42792494351a68568e23a9/src/constants/endpoints.ts).
- [OAuth client_credentials e autenticação Basic](https://github.com/efipay/sdk-node-apis-efi/blob/d742ee94b76097383c42792494351a68568e23a9/src/wrapper.ts).
- [Certificado P12/PEM e transporte HTTPS](https://github.com/efipay/sdk-node-apis-efi/blob/d742ee94b76097383c42792494351a68568e23a9/src/httpClient.ts).
- [Schemas de cobrança, recebimento, QR e devolução](https://github.com/efipay/sdk-node-apis-efi/blob/d742ee94b76097383c42792494351a68568e23a9/src/types/pix.ts).
- [Exemplo de configuração de webhook com validação mTLS ativa](https://github.com/efipay/sdk-node-apis-efi/blob/d742ee94b76097383c42792494351a68568e23a9/examples/ts/pix/webhooks/cob-cobv/pixConfigWebhook.ts).

Referência operacional: [documentação oficial de cobranças imediatas](https://dev.efipay.com.br/docs/api-pix/cobrancas-imediatas).
O adaptador usa os contratos acima diretamente, sem incorporar ou executar o SDK.

## Credenciais e certificado

Configure os valores nas variáveis seguras do processo e monte os arquivos do
certificado fora do checkout. Não envie arquivos privados ou valores pelo chat.

| Variável | Configuração do adaptador | Observação |
| --- | --- | --- |
| `EFI_CLIENT_ID` | `clientId` | Aplicação Efí habilitada para API PIX |
| `EFI_CLIENT_SECRET` | `clientSecret` | Segredo da aplicação; nunca registrar em logs |
| `EFI_PIX_KEY` | `pixKey` | Chave PIX da conta recebedora autorizada |
| `EFI_CERT_FILE` | `certFile` | Caminho do arquivo `.p12`/`.pfx` ou certificado `.pem`/`.crt` |
| `EFI_KEY_FILE` | `keyFile` | Obrigatório para PEM/CRT; caminho da chave privada correspondente |
| `EFI_CERT_PASSPHRASE` | `passphrase` | Opcional, conforme a proteção do certificado/chave |
| `EFI_SANDBOX` | `sandbox` | Booleano explícito; homologação e produção usam credenciais/certificados compatíveis |

O construtor recebe `EfiPixConfig`; a seleção do provedor e leitura dessas variáveis
pertencem à inicialização da aplicação. Client ID, secret, chave PIX, ambiente e
certificado ausentes produzem um erro explícito de integração desabilitada.
Arquivo ausente, chave PEM incompatível e passphrase incorreta falham antes da rede.

As credenciais precisam estar disponíveis ao processo para montar o cabeçalho
OAuth Basic e autenticar mTLS. Placeholders substituídos apenas pelo proxy em
HTTPS não equivalem a credenciais reais para esses dois mecanismos.

## Transporte e autenticação

- Produção: `https://pix.api.efipay.com.br`.
- Homologação: `https://pix-h.api.efipay.com.br`.
- OAuth: `POST /oauth/token`, cabeçalho Basic e JSON
  `{"grant_type":"client_credentials"}`.
- Certificado mTLS enviado em OAuth e nas operações PIX.
- `node:https` com CAs padrão do Node, validação padrão de hostname,
  `rejectUnauthorized: true` e TLS mínimo 1.2.
- Não há opção para desabilitar TLS, alterar o host por variável de ambiente,
  seguir redirects ou repetir automaticamente uma escrita.
- Token cacheado somente em memória, com margem antes da expiração e uma única
  autenticação compartilhada entre requisições concorrentes.
- HTTP 401 invalida o cache; a operação não é repetida automaticamente.
- Timeout total padrão de 15 segundos e resposta limitada a 1 MiB.
- Erros omitem payloads, cabeçalhos, certificados, caminhos e valores secretos.

O caminho de rede deve suportar mTLS até a Efí. Uma interceptação TLS ou um proxy
que não encaminhe essa autenticação impede a integração; não contorne a validação
para fazer uma chamada passar.

## Cobrança e consulta

`EfiPixProvider` implementa `PixGateway`:

```ts
const payment = await provider.createPix({
  reference,          // 26 a 35 letras/números; o faturamento usa 32 caracteres
  idempotencyKey,     // chave estável da operação local
  amountCents,        // inteiro positivo em centavos
  payerEmail,         // contrato compartilhado; a Efí não recebe esse campo
  description,       // opcional; até 140 caracteres
  expiresInSeconds,  // opcional; de 60 a 86400 segundos
});
const canonical = await provider.getPayment(payment.id);
```

1. A referência é preservada como `txid`, sem hash ou transformação.
2. Primeiro consulta `GET /v2/cob/{txid}`. Uma cobrança existente com o mesmo
   valor é reutilizada; valor diferente falha como conflito de idempotência.
3. Somente uma ausência HTTP 404 permite `PUT /v2/cob/{txid}`.
4. O corpo contém calendário, valor decimal exato, chave PIX e descrição opcional.
   Dados do devedor são opcionais no contrato oficial; CPF, nome e email não são
   enviados por este adaptador.
5. `GET /v2/loc/{id}/qrcode` fornece QR e PIX copia e cola. Se a imagem falhar,
   um código copia e cola já retornado pela cobrança continua disponível.
6. Depois de timeout ou erro de escrita, consulte a mesma referência. Não crie
   outro `txid` apenas para tentar contornar uma resposta incerta.

O retorno normalizado contém `id`, `externalReference` (o próprio txid),
`amountCents`, `status`, `expiresAt`, `refundedCents` e, quando disponíveis,
`pixCopyPaste` e `qrCode` (PNG em base64, sem prefixo de data URI).

A confirmação não usa mensagem recebida por email, comprovante ou webhook como
autoridade financeira. `approved` exige a consulta canônica com status
`CONCLUIDA`, recebimentos sem duplicação, txid correspondente e soma exatamente
igual ao valor da cobrança. Dados inesperados impedem aprovação. Uma cobrança
concluída sem os recebimentos associados permanece `unknown` até reconciliação.

Devolução integral confirmada normaliza para `refunded`. Uma devolução parcial
confirmada expõe `refundedCents` e permanece `unknown` para revisão, sem tratá-la
como novo pagamento integral disponível. Cobranças ativas expiradas retornam
`expired`; removidas pelo recebedor/PSP retornam `cancelled`.

## Recebimentos e devoluções opcionais

Os seguintes métodos estão disponíveis ao serviço financeiro, sem disparo
automático por uma análise ou mensagem do usuário:

- `getReceivedPix(endToEndId)`: `GET /v2/pix/{endToEndId}`; retorna valor recebido,
  devolvido e reservado em devoluções em processamento.
- `getRefund(endToEndId, id)`: consulta canônica em
  `GET /v2/pix/{endToEndId}/devolucao/{id}`.
- `refundPix(endToEndId, id, amountCents)`: consulta a referência de devolução e
  o recebimento antes de `PUT /v2/pix/{endToEndId}/devolucao/{id}`.

A referência de devolução é alfanumérica e estável, com até 35 caracteres. O valor
não pode exceder o recebimento ainda disponível, descontadas devoluções concluídas
e em processamento. Retorno `pending` significa `EM_PROCESSAMENTO`; somente
`DEVOLVIDO` normaliza para `refunded`. A decisão de solicitar devolução deve vir
do fluxo financeiro autorizado, com registro local e reconciliação posterior.

## Webhooks

Esta implementação não abre um endpoint de webhook Efí nem o registra sem mTLS.
O SDK oficial mostra a configuração com `x-skip-mtls-checking: false`; este projeto
não implementa o bypass dessa verificação. O caminho disponível é polling
autenticado via `getPayment(txid)`.

Uma implantação futura de webhook precisa validar o certificado cliente Efí no
terminador TLS, manter a verificação ativa e tratar o JSON recebido somente como
um aviso para uma consulta canônica. Não basta confiar no corpo ou em cabeçalhos
encaminhados por um remetente não autenticado.

## Testes e validação pendente

Os testes usam um transporte HTTPS falso injetado explicitamente pelo construtor,
sem configuração de ambiente que possa relaxar a segurança. Um teste adicional
gera um certificado/P12 efêmero, usa o agente real e comprova que ele rejeita uma
CA de servidor não confiável com a verificação TLS ativa.

```bash
npm run build
node --test dist/tests/efi.test.js
```

Faltam: credenciais e certificado compatíveis, escopos habilitados na aplicação,
acesso de rede mTLS, criação/consulta em homologação e validação operacional em
produção. A presença do adaptador e os testes locais não comprovam essas etapas.
