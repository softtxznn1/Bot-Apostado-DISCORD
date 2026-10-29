# Mercado Pago — adaptador PIX

O adaptador está em `src/payment-providers/mercadopago.ts`. Ele usa a Payments
API oficial via HTTPS, sem adicionar o SDK ao projeto. Os contratos foram
conferidos nas fontes oficiais do SDK Node.js em 25/10/2026.

## Estado de validação

- Criação, consulta, busca por referência, estorno integral e assinatura de webhook
  foram testados com um servidor HTTP local e respostas de contrato.
- Não foram usadas credenciais reais nem executados pagamentos ou estornos reais.
- A indicação do provedor não comprova elegibilidade da atividade. Antes de ativar
  cobrança, confirme com o Mercado Pago que a conta e a operação pretendida são
  aceitas, obtenha as credenciais apropriadas e valide o fluxo de teste disponível.
- A habilitação no bot depende da configuração e da orquestração financeira do
  projeto. Instanciar o adaptador não cria cobrança; nenhuma chamada ocorre no construtor.

## Interface

```ts
const provider = new MercadoPagoPixProvider({
  accessToken: process.env.MP_ACCESS_TOKEN!,
  webhookSecret: process.env.MP_WEBHOOK_SECRET!,
  timeoutMs: 10_000,
});

const payment = await provider.createPix({
  reference: 'referencia-interna-da-partida-e-jogador',
  idempotencyKey: 'chave-persistida-antes-da-chamada',
  amountCents: 250,
  payerEmail: 'pagador@example.com',
});
```

O token e o segredo do webhook são privados e separados. Não os imprima nem os
grave em código, respostas, logs ou commits. O e-mail do pagador é um dado de
cadastro exigido pela API; ele não comprova pagamento.

| Método | Operação |
| --- | --- |
| `createPix(input)` | `POST /v1/payments`, `payment_method_id=pix`, valor em BRL e `X-Idempotency-Key` persistida |
| `getPayment(id)` | `GET /v1/payments/{id}`, usado como recurso canônico |
| `findPaymentByReference(reference)` | Busca `GET /v1/payments/search` e consulta canônica do único resultado |
| `refundPayment(id, idempotencyKey)` | Consulta o pagamento e solicita estorno integral via `POST /v1/payments/{id}/refunds` com `{}` |
| `verifyWebhook(input)` | Valida a assinatura com o segredo privado do adaptador, sem acessar a rede |
| `canonicalPaymentFromWebhook(input)` | Valida assinatura e consulta o pagamento por GET; ignora o status do corpo da notificação |

`createPix` aceita `reference`, `idempotencyKey`, `amountCents`, `payerEmail` e,
opcionalmente, `description` e `expiresInSeconds`. Os limites locais da aplicação
são 1 a 99999999 centavos, referência interna de até 128 caracteres e chave de
idempotência de 8 a 64 caracteres. Não são afirmações sobre os limites comerciais
do provedor. Descrição e expiração também precisam ser aceitas pela conta/API.

O retorno normalizado contém `id`, `status`, `amountCents`, `externalReference`,
`refundedCents` e, quando retornados, `qrCode` (PNG base64), `pixCopyPaste` e
`expiresAt` (ISO 8601). Não inclui e-mail, identificação pessoal ou o token.

`approved` é preservado somente quando a consulta foi validada como PIX em BRL.
Estados `authorized`, `in_process` e `in_mediation` são normalizados como `pending`.
Estado desconhecido, inclusive `charged_back`, não é convertido em aprovação.
O consumidor deve conferir referência, valor e `refundedCents` contra a cobrança
persistida; um pagamento aprovado mas parcialmente estornado não representa
quitação integral. IDs inseguros, valores com frações de centavo, resposta para
outra moeda/método e troca de ID/referência são rejeitados.

## Idempotência e recuperação

Grave a chave de idempotência e os dados da cobrança no banco **antes** do POST.
Use a mesma chave somente para a mesma operação e o mesmo payload. O adaptador
não repete POST automaticamente. Ele impede redirects, limita tempo e tamanho de
resposta e não expõe o corpo de erros retornados pelo provedor.

- Rejeições HTTP 400/401/403/404/422 produzem `PAYMENT_NOT_CREATED`.
- Timeout, perda de conexão, redirect, HTTP 5xx e criação com resposta inválida
  produzem `PAYMENT_WRITE_UNCERTAIN`: o pedido pode ter sido processado.
- Falhas de GET produzem `PAYMENT_READ_FAILED`.
- Busca com múltiplos pagamentos, resposta inconsistente ou paginação ambígua
  produz `PAYMENT_LOOKUP_AMBIGUOUS`; não selecione o pagamento mais recente às cegas.

Após resposta perdida, consulte por ID ou por referência antes de considerar uma
nova tentativa. `undefined` na busca não prova que o pedido não ocorreu: a busca
pode ainda não refletir a criação. Mantenha o estado pendente e repita a consulta.
Se repetir uma escrita após diagnóstico, use a chave persistida original.

O estorno integral aceita apenas pagamento aprovado sem estorno anterior. Depois
de uma resposta perdida no estorno, consulte o pagamento e os registros já
persistidos antes de repetir. Não se deve converter timeout em uma segunda saída.
O adaptador não implementa saque ou pagamento de prêmio por PIX.

## Webhooks

Cadastre no Mercado Pago uma URL HTTPS pública da aplicação para notificações de
pagamento e configure um segredo de assinatura separado (`MP_WEBHOOK_SECRET`).
Não use a URL local do teste nem compartilhe o segredo com o cliente/browser.

O parser recebe os cabeçalhos **brutos** do servidor e a URL completa da requisição:

```ts
const input = parseMercadoPagoWebhookRequest(request.rawHeaders, request.url!);
const verified = provider.verifyWebhook(input);
// Grave/deplique a notificação e consulte o recurso em trabalho persistente.
const payment = await provider.getPayment(verified.paymentId);
```

`parseMercadoPagoWebhookRequest` exige uma ocorrência de `x-signature`, uma de
`x-request-id` e um parâmetro `data.id`. Ele rejeita cabeçalhos/query duplicados em
vez de escolher o primeiro valor ou confiar em coerção de arrays pelo framework.
Proxies devem preservar esses campos sem os sobrescrever com dados do usuário.

O manifesto assinado é exatamente:

```text
id:<data.id>;request-id:<x-request-id>;ts:<ts>;
```

A verificação utiliza HMAC-SHA256 e comparação de tempo constante, exige `v1`
hexadecimal e valida janela de 300 segundos nos dois sentidos. O valor `ts` é
preservado no manifesto; a janela aceita segundos e o formato legado em
milissegundos. Timestamps fora da janela, campos duplicados, arrays e assinaturas
malformadas são recusados. Ajustes de tolerância, quando usados diretamente na
função exportada, ficam limitados a 1–900 segundos.

O corpo da notificação é apenas um aviso. Não libere partida com base em `status`
recebido pelo webhook, e-mail, screenshot, mensagem de jogador ou redirecionamento
do navegador. Depois da assinatura, recupere o pagamento por GET e aplique a
mudança no banco de forma idempotente. Eventos podem se repetir ou chegar fora
de ordem. Relógio do servidor precisa estar sincronizado.

A validação implementada cobre notificações assinadas da Payments API. Não trate
notificações QR Code sem assinatura como exceções automaticamente confiáveis.

## Rede e testes

O host de produção é fixo em `https://api.mercadopago.com`; não existe uma variável
para trocar esse destino e enviar tokens a outro domínio. `testBaseUrl` é um
parâmetro explícito exclusivo de testes e aceita somente uma origem HTTP literal
de loopback (`127.0.0.1` ou `[::1]`), sem caminho, usuário, senha ou query.
Use somente credenciais falsas nesse servidor de contrato.

O ambiente precisa permitir HTTPS a `api.mercadopago.com` para chamadas reais.
A URL pública de webhook precisa de hospedagem e TLS apropriados; o dashboard
local por si só não estabelece essa conectividade.

## Fontes oficiais consultadas

Commit do SDK consultado: `bf920b9415ba19986b7ffdbf83a5aa21b589a6e0`.

- [SDK oficial e requisitos](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/README.md).
- [Criação de pagamentos](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/clients/payment/create/index.ts) e [campos da requisição](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/clients/payment/create/types.ts).
- [Resposta de pagamento e dados PIX](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/clients/payment/commonTypes.ts).
- [Consulta por ID](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/clients/payment/get/index.ts) e [busca por referência](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/clients/payment/search/types.ts).
- [Estorno integral](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/clients/paymentRefund/total/index.ts).
- [Guia oficial de webhooks](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/docs/webhooks.md) e [validador HMAC do SDK](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/utils/webhook/index.ts).
- [Retries e idempotência](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/docs/request-options.md).

O portal oficial de documentação web retornou bloqueio de rede neste ambiente;
por isso foram usadas as fontes oficiais do SDK no GitHub, com commit fixado.
