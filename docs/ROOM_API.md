# Integração HTTP de salas

> **Contrato atual e evolução planejada:** este documento descreve a implementação
> existente de criação e recuperação por referência. Ela ainda depende de partida
> e não cobre mapa, capacidade, edição, consulta completa, cancelamento ou encerramento.
> O novo escopo está em [PLANO.md](../PLANO.md). Todas as operações obrigatórias
> precisam ser confirmadas com o fornecedor e implementadas no adaptador definitivo.

`HttpRoomProvider` implementa o **contrato próprio `room-contract-v1`** abaixo.
Esse contrato permite conectar um gateway controlado pelo operador ou um provedor
que tenha confirmado esses campos. Ele não certifica compatibilidade com SalasFF,
Garena nem qualquer outro fornecedor e não promete salas ilimitadas.

## Configuração programática

```ts
const provider = new HttpRoomProvider({
  contract: 'room-contract-v1',
  baseUrl: 'https://api-do-seu-gateway.example',
  apiKey: /* credencial injetada por variável segura */,
  createPath: '/rooms',
  lookupPath: '/rooms/lookup', // omita se não houver consulta por referência
  lookupMethod: 'GET',       // ou POST, conforme o contrato confirmado
  authorizationScheme: 'Bearer', // ou raw para Authorization sem prefixo
  getMatch: reference => /* obter id, teamSize, platform e rules da partida */,
});
```

O exemplo descreve a interface; os comentários precisam ser substituídos por
código real, e nenhum dos hosts apresentados representa um serviço disponível.
A origem precisa usar HTTPS e não pode incluir caminho, query ou credenciais.
Os caminhos são absolutos e da mesma origem. HTTP é aceito exclusivamente em
loopback com `allowLocalHttpForTests: true` definido programaticamente nos testes.
Não há opção de desativar a verificação TLS.

## Criar sala

O adaptador envia uma única requisição POST ao caminho configurado:

```http
Authorization: Bearer <credencial>
Idempotency-Key: <ID estável da partida>
Content-Type: application/json
Accept: application/json
```

```json
{
  "reference": "ID-estavel-da-partida",
  "mode": "2x2",
  "platform": "mobile",
  "rules": "Regras confirmadas pelos participantes."
}
```

Plataformas: `mobile`, `emulador`, `misto`. Modos: `1x1` até `4x4`.
O gateway deve efetivamente aplicar as regras ou rejeitar as que não suporta;
receber esses campos não prova que o jogo permite automatizar cada opção.
O cabeçalho de idempotência só protege contra duplicação se o servidor também
implementar essa garantia. O adaptador não repete POST automaticamente.

A confirmação exige HTTP 200/201 e `Content-Type: application/json`:

```json
{
  "reference": "ID-estavel-da-partida",
  "room": { "id": "12345678", "password": "senha123" }
}
```

`reference` deve corresponder exatamente à partida. ID e senha são strings de
1–64 caracteres: letras ASCII, números, `_` ou `-`. A origem retornada ao domínio
é sempre `external`; qualquer campo `source` fornecido pelo servidor é ignorado.
Um ID gerado pelo nosso bot não será tratado como confirmação de uma sala no jogo.

## Consultar após uma resposta incerta

Com `lookupMethod: 'GET'`, a referência vai em `?reference=<ID>`. Com POST, o
corpo é `{ "reference": "<ID>" }`. A autenticação é a mesma da criação.
Uma consulta concluída devolve o mesmo envelope JSON da criação.

HTTP 202/404/410 ou JSON `{ "reference": "<ID>", "status": "pending" }`
indicam que a consulta não confirmou a sala. Isso mantém a criação pendente;
**não autoriza repetir o POST de criação**. Sem `lookupPath`, `findRoom` retorna
`undefined` sem fazer uma requisição. O operador precisa consultar o fornecedor.

4xx/5xx na criação, timeout, interrupção, redirecionamento e resposta inválida
também são tratados como resultado incerto. O adaptador nunca presume que a sala
não foi criada apenas porque a resposta falhou. A resolução de uma criação
incerta precisa vir de consulta verificável ou de intervenção documentada.

## Limites e dados sensíveis

- Timeout padrão: 10 segundos, configurável entre 20 ms e 60 segundos.
- Resposta máxima: 64 KiB, configurável entre 256 bytes e 1 MiB.
- Não segue redirects, para evitar enviar credenciais a outro destino.
- Erros não incluem chave, corpo HTTP, URL ou causa original da biblioteca HTTP.
- A identidade persistente do provedor deriva da origem, caminhos, método de
  consulta e contrato. Trocar a chave não altera essa identidade; trocar o
  fornecedor ou endpoint impede reconciliar um pedido antigo com outro serviço.
- O payload não envia nomes Discord, documentos, valores de apostas ou tokens.
- Logs e auditoria não devem registrar ID/senha completos da sala ou credenciais.

## O que permanece externo

É necessário escolher um fornecedor, confirmar seu contrato e autorização,
traduzir campos quando ele usar outro protocolo, fornecer uma chave válida,
liberar os hosts de rede e testar uma criação real com entrada no Free Fire.
O código público citado na pesquisa usa endpoints e campos diferentes deste
contrato; não foi copiado como uma especificação oficial nem validado ao vivo.
Os testes deste adaptador usam um servidor HTTP local controlado e não certificam
disponibilidade, custo, cotas, região BR ou funcionamento comercial de fornecedor.
