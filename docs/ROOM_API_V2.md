# API de gerenciamento de salas — contrato v2

`HttpManagedRoomProvider` implementa o contrato explícito **`room-management-v2`**
para criação e gerenciamento de salas independentes. Este é um contrato deste
projeto, não uma especificação verificada da Storm Salas, SalasFF ou Garena.
É necessário escolher o fornecedor e confirmar seu protocolo ou implementar um
gateway que traduza suas operações reais para o contrato abaixo.

## Ativação e requisitos

Configuração programática:

```ts
const provider = new HttpManagedRoomProvider({
  contract: 'room-management-v2',
  baseUrl: 'https://gateway-controlado.example',
  apiKey: process.env.ROOMS_API_KEY!,
  authorizationScheme: 'Bearer', // ou raw, conforme o fornecedor/gateway
});
```

O host de exemplo não representa serviço disponível. A configuração do processo
Discord está documentada no guia de execução da edição de salas.

- A URL contém somente a origem HTTPS, sem caminho, credenciais, query ou fragmento.
- Autenticação vai em `Authorization: Bearer <credencial>` ou em `Authorization`
  sem prefixo quando configurado como `raw`.
- Não há opção para desligar verificação de certificado TLS.
- HTTP só é aceito em endereço literal de loopback e com
  `allowLocalHttpForTests: true` passado programaticamente pelos testes.
- A identidade persistida combina origem e versão do contrato, sem chave secreta.
  Trocar origem impede reconciliar pedido antigo contra outro fornecedor.
- A API deve oferecer todas as operações obrigatórias do cliente. Capacidade
  ausente é um bloqueio de integração, não uma implementação concluída.

## Rotas

| Método e rota | Função | Corpo |
| --- | --- | --- |
| `GET /v2/catalog` | Catálogo e capacidades | Sem corpo |
| `POST /v2/rooms` | Criar sala | `{ reference, options }` |
| `GET /v2/rooms/:id` | Consultar sala e estado | Sem corpo |
| `GET /v2/rooms/lookup?reference=...` | Recuperar criação incerta | Sem corpo |
| `PATCH /v2/rooms/:id` | Atualizar opções | `{ options }` |
| `POST /v2/rooms/:id/cancel` | Cancelar remotamente | `{ reason }` |
| `POST /v2/rooms/:id/close` | Encerrar remotamente | `{ reason }` |

Todas as escritas levam `Idempotency-Key` estável da operação persistida. A API
deve implementar essa garantia; o cliente não pode assegurar idempotência somente
enviando um cabeçalho. Não existe retentativa automática de escritas.
IDs de caminho e referências são codificados; não são aceitos caminhos arbitrários.

## Catálogo

Resposta HTTP 200 com `Content-Type: application/json`:

```json
{
  "catalog": {
    "revision": "catalogo-confirmado-v1",
    "maps": [{ "id": "map-a", "label": "Mapa confirmado pelo provedor" }],
    "modes": [{
      "id": "mode-a",
      "label": "Modo confirmado pelo provedor",
      "mapIds": ["map-a"],
      "minPlayers": 2,
      "maxPlayers": 50,
      "playerStep": 1,
      "editableFields": ["name", "mapId", "maxPlayers", "password"],
      "optionFields": [{
        "id": "rounds",
        "label": "Rodadas",
        "type": "integer",
        "min": 1,
        "max": 13,
        "required": false,
        "editable": true
      }]
    }],
    "capabilities": {
      "create": true,
      "lookup": true,
      "query": true,
      "update": true,
      "cancel": true,
      "close": true
    }
  }
}
```

Os valores são exemplos de formato, sem promessa sobre configurações reais do
Free Fire. Somente os IDs e limites confirmados pelo fornecedor devem ser usados.

`editableFields` declara explicitamente quais campos básicos podem ser alterados:
`name`, `modeId`, `mapId`, `maxPlayers`, `password`. A lista pode estar vazia.
Cada campo extra tem tipo `string`, `integer`, `boolean` ou `choice`; escolhas
usam `choices: [{ value, label }]`. `maxLength` limita texto, `min/max` limitam
inteiros e `editable: true` permite editar aquela opção depois da criação.

IDs duplicados, mapas inexistentes nos modos, intervalos inválidos e capacidades
sem booleanos são recusados. O catálogo admite até 100 modos, 1000 mapas e 30
opções por modo; a UI deve paginar as listas que ultrapassam os limites do Discord.

## Opções e retorno de sala

```json
{
  "reference": "UUID-local-estavel",
  "options": {
    "name": "Sala do evento",
    "modeId": "mode-a",
    "mapId": "map-a",
    "maxPlayers": 10,
    "password": "senha123",
    "extras": { "rounds": 7 }
  }
}
```

Nome, modo, mapa e capacidade são obrigatórios. A senha pode ser omitida na
criação para o fornecedor atribuí-la; edição sem senha mantém a senha atual.
`extras` aceita somente campos liberados pelo catálogo e pela configuração do
servidor. O serviço de domínio valida tipos, compatibilidade, capacidade e cargos
antes da requisição; não se envia JSON arbitrário digitado pelo usuário.

Criação concluída retorna HTTP 200/201; consultas e alterações concluídas usam o
mesmo envelope, com os dados realmente aplicados:

```json
{
  "room": {
    "id": "ID-utilizavel-no-jogo",
    "reference": "UUID-local-estavel",
    "state": "open",
    "name": "Sala do evento",
    "modeId": "mode-a",
    "mapId": "map-a",
    "maxPlayers": 10,
    "password": "senha123",
    "extras": { "rounds": 7 },
    "expiresAt": 1900000000000
  }
}
```

`state` aceita `open`, `running`, `cancelled`, `closed` ou `expired`.
`expiresAt` é opcional, em milissegundos Unix. `password` deve ser uma string ou
`null` para sala sem senha. O adaptador ignora campos desconhecidos, sem expor
o objeto bruto do fornecedor. A origem `external` vem da instância do adaptador;
não pode ser alterada por um campo `source` recebido na resposta.

Na criação e no lookup, `reference` precisa coincidir com o pedido. Consultas e
alterações por ID precisam devolver o mesmo ID. O domínio também confirma opções,
referência e transição de estado antes de divulgar dados ou encerrar a operação.
HTTP 2xx com estado antigo não comprova cancelamento/encerramento.

## Respostas incertas

- HTTP 202 em escrita retorna resultado pendente, sem fabricar dados de sala.
- Lookup com HTTP 202/404 retorna resultado ainda indeterminado; não autoriza
  uma nova criação. Consulta por ID ausente não vira cancelamento automaticamente.
- Timeout, rede, 4xx/5xx, redirecionamento e resposta inválida nunca provam que
  uma escrita deixou de acontecer. A operação permanece para reconciliação.
- O adaptador não segue redirects nem repete POST/PATCH automaticamente.
- Consultar criação pendente usa a referência. Alterações pendentes consultam
  a sala e só são concluídas quando as opções/estado esperados são confirmados.

Timeout padrão de 10 segundos, configurável entre 20 ms e 60 segundos. Limite de
resposta padrão de 64 KiB, configurável até 1 MiB. Corpo JSON, tamanho e campos são
validados; falhas não incluem chave, URL ou corpo retornado pelo fornecedor.

HTTP 429 ativa uma pausa por instância do adaptador, compartilhada entre catálogo,
consultas e escritas. `Retry-After` aceita segundos ou data HTTP em GMT; cabeçalho
ausente/inválido/passado usa 30 segundos. A espera fica entre 1 segundo e 24 horas.
Durante a pausa nenhuma nova requisição é enviada; uma nova chamada só pode ocorrer
depois do prazo. Não existe agendamento nem repetição automática da escrita que
recebeu 429. Criação incerta continua salva e será consultada por referência.
A pausa não é persistida entre reinícios nem coordenada entre processos; use uma
instância do bot e respeite também as cotas contratadas com o fornecedor.

## Simulador persistente

`new SimulatedManagedRoomProvider(store)` fornece o mesmo ciclo de criação,
consulta, edição, cancelamento e encerramento em SQLite. Salas têm prefixo `SIM-`,
origem `simulated` e catálogo com rótulos de **DEMONSTRAÇÃO**. O simulador mantém
salas e chaves de operação após reinício; reutilizar chave com parâmetros diferentes
gera conflito. Os modos `demo-standard` e `demo-duel` não representam catálogo
comercial confirmado do jogo.

Os testes HTTP locais verificam rotas, parâmetros, autenticação, estado pendente,
limites, redirects e dados inconsistentes. Os testes SQLite verificam persistência
do simulador. Isso não substitui selecionar fornecedor, apresentar credenciais,
validar todas as operações no serviço real e entrar na sala no Free Fire.
