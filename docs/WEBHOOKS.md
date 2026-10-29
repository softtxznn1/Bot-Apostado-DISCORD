# Notificações de pagamento

O receptor `createPaymentWebhookServer` aceita somente
`POST /webhooks/mercadopago?data.id=<ID>`. Ele deve executar em um processo/porta
separado do dashboard administrativo. A integração de início do processo depende
do `PaymentHub` e deve reutilizar o mesmo banco e vínculo da conta configurada.

## Fluxo de confiança

1. Rejeitar método/caminho incorreto e limitar cabeçalhos, corpo e frequência.
2. Obter `x-signature`, `x-request-id` e `data.id` sem aceitar duplicatas.
3. Verificar HMAC e a validade temporal usando o segredo de webhook do Mercado Pago.
4. Consultar o pagamento por GET canônico autenticado no Mercado Pago.
5. Passar essa resposta ao conciliador persistente da aplicação.
6. O conciliador verifica provedor/conta, ID remoto, referência externa e valor
   esperados antes de confirmar recebimento no razão contábil.

O corpo recebido precisa ser JSON com até 16 KiB. Campos como `status`, valor,
e-mail ou `data.id` no corpo **não confirmam um pagamento**. O ID usado na consulta
vem dos parâmetros cobertos pela assinatura. A resposta pública contém somente
confirmação de recebimento; códigos PIX, nomes, documentos e saldos não retornam.

O callback deve reconhecer eventos sem cobrança local e concluir sem crédito,
retornando HTTP 200 para evitar tentativas infinitas de um evento desconhecido.
Cobranças conhecidas precisam de conciliação idempotente no banco. A deduplicação
do receptor não substitui essa verificação financeira.

## Contrato de integração

```ts
createPaymentWebhookServer({
  mercadoPago: provider,
  onMercadoPagoPayment: async payment => {
    const intent = billing.findByRemoteId(payment.id);
    if (!intent) return;
    await billing.reconcilePending(intent.id);
  },
});
```

`provider` deve ser o `MercadoPagoPixProvider` configurado com access token e
segredo de webhook distintos. `billing` precisa estar vinculado à mesma conta.
O exemplo usa nova consulta canônica no serviço de conciliação; o corpo bruto
do webhook nunca é convertido em crédito. O código de inicialização não deve
criar outro provedor/conta nem procurar cobranças ignorando a identidade da conta.

## Repetições, falhas e limites

- HMAC é validado antes de qualquer consulta externa, inclusive em repetições.
- Eventos iguais em execução compartilham uma consulta e um callback.
- Após sucesso, há cache temporário por ID, request ID e timestamp, com TTL padrão
  de cinco minutos e no máximo 1000 entradas. O cache só registra sucesso depois
  de concluir o callback. A chave usa hash e não inclui os segredos.
- Timeout ou erro do provedor/conciliador retorna 503 e permite nova tentativa.
- Falha nunca é armazenada como sucesso. Após reinício, o banco continua sendo a
  barreira persistente contra crédito duplicado.
- Assinatura inválida retorna 401; cabeçalhos/query duplicados retornam 400.
- Corpo excessivo retorna 413; excesso de requisições retorna 429 com Retry-After.
- O limite padrão é 300 requisições por minuto por endereço de conexão. O receptor
  não confia em `X-Forwarded-For`; ajuste o limite considerando seu proxy reverso.

## Publicação

O servidor HTTP deve escutar em loopback por padrão. O endpoint de notificação
cadastrado no Mercado Pago deve ser uma URL HTTPS pública de um proxy reverso
controlado, com TLS válido, limite de conexão e encaminhamento para essa porta
local. Preserve os cabeçalhos de assinatura e a query, sem juntar notificações.
Não exponha dashboard ou outros processos pela mesma rota pública.

Não registre corpos, access token, segredo de webhook ou cabeçalhos de assinatura
em logs de aplicação/proxy. Não coloque segredos na URL. A validade do HMAC depende
do relógio do servidor; mantenha a máquina sincronizada.

**Efí:** este receptor não possui rota Efí. O recebimento de webhook Efí exige
verificação mTLS correta; remover essa proteção para receber notificações não é
uma alternativa. Enquanto esse receptor mTLS não for configurado e testado, a
conciliação Efí deve usar consultas autenticadas/polling canônico.

## Evidência e dependências externas

Os testes executam servidores HTTP locais e assinaturas HMAC com segredos de teste.
Isso verifica o código do receptor e a ordem de autenticação/consulta, mas não
valida credenciais, configuração comercial da conta, proxy HTTPS público ou uma
notificação de pagamento real. Esses passos precisam de acesso do operador e não
foram certificados pelo teste local.
