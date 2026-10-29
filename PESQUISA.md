# Pesquisa de bots de apostados e salas de Free Fire

Consulta: 25/10/2026. Pesquisa documental e leitura estática de código público;
nenhum dos produtos abaixo foi instalado, contratado ou testado em um servidor real.

## Recomendação

**Infinity Bot, de Abyys0, é a referência funcional mais abrangente entre os
projetos examinados.** Isso não demonstra que seja o melhor produto comercial,
o mais utilizado ou o bot dos maiores servidores. A recomendação para este
repositório é desenvolver uma implementação própria, usando os requisitos como
referência, com persistência transacional e uma integração de salas validada.

Os dois repositórios Infinity do mesmo autor têm documentação muito semelhante;
não foram contados como dois concorrentes independentes.

## Comparação baseada nas fontes

| Referência | Evidências encontradas | Limitação relevante | Uso no nosso planejamento |
| --- | --- | --- | --- |
| [Infinity Bot](https://github.com/Abyys0/Infinity-Bot) | Documenta filas 1x1–4x4, mobile/emulador/misto, valores, mediadores, analistas, tickets, blacklist, ranking, painel e logs; há implementações desses módulos no código | Dados em arquivos JSON; confirmação de pagamento por mediador; não identifiquei cliente de criação de salas no jogo na revisão estática | Principal referência de requisitos do Discord |
| [Salas FF — Telegram](https://github.com/Cajuz/bot_telegram-loop_salas) | Documenta venda de créditos, chaves, histórico, administração e PIX; código contém cliente HTTP para criar, consultar e iniciar salas, além de expulsar jogadores | É Telegram; funcionamento, autorização e condições comerciais da API externa não foram verificados; README declara uso interno | Referência para separar integração de salas, créditos e interface do bot |
| [bot-org](https://github.com/eudrexx/bot-org) | Código contém organização de categorias, filas, mensagens e canais de partidas | Estruturas de fila em memória; não demonstra criação de sala no Free Fire | Referência de experiência simples para filas |
| [freefire-bet-bot](https://github.com/gomes0499/freefire-bet-bot) | Documenta Discord/Telegram, comissões, participantes e canais privados | O código Discord gera códigos locais aleatórios e mantém salas em dicionários; isso não cria uma sala no jogo | Referência de mediação e permissões, sem assumir integração real |
| [FF Salas Bot V4](https://github.com/wandercleysantos73-png/ff-salas-bot) | Documenta gestão/venda de salas pelo Telegram | O próprio README informa que PIX é um placeholder, sem confirmação automática | Exemplo de função anunciada que ainda depende de implementação |
| [Auto Salas FF](https://github.com/kayohenriquevieira1-ops/https-github.com-kayohenrique-bot-auto-salas) | README descreve criação automática de salas e divulgação de dados | Na versão consultada havia apenas README; implementação não comprovada | Não usar como comprovação de uma API operacional |

## O que foi conferido no Infinity

- O README descreve os modos 1x1, 2x2, 3x3 e 4x4 e as três plataformas.
- Há comandos e handlers para filas, mediadores, analistas, tickets, blacklist e ranking.
- Foram examinados estaticamente 58 arquivos JavaScript do commit consultado.
- A camada de dados lê e regrava arquivos JSON. Não foi identificada nessa camada
  uma transação de banco que proteja operações concorrentes de fila ou resultado.
- O comando PIX cadastra a chave do mediador; o recebimento é confirmado por um
  mediador em um botão. Isso não equivale a conciliação automática por banco.
- Não identifiquei integração externa de criação de salas nesse conjunto de fontes.
- Nenhum teste de carga, disponibilidade, segurança ou fluxo real foi executado.

Fontes fixadas para permitir conferir o que foi consultado:

- [README e funcionalidades do Infinity](https://github.com/Abyys0/Infinity-Bot/blob/a23b6e8d8dd5feb56be5c0edc3829ffe869ac9f7/README.md).
- [Persistência JSON](https://github.com/Abyys0/Infinity-Bot/blob/a23b6e8d8dd5feb56be5c0edc3829ffe869ac9f7/src/database/index.js#L69).
- [Configuração de PIX](https://github.com/Abyys0/Infinity-Bot/blob/a23b6e8d8dd5feb56be5c0edc3829ffe869ac9f7/src/commands/pix.js#L45).
- [Confirmação manual de pagamento](https://github.com/Abyys0/Infinity-Bot/blob/a23b6e8d8dd5feb56be5c0edc3829ffe869ac9f7/src/handlers/buttons/queueButtons.js#L943).
- [Outro repositório Infinity do mesmo autor](https://github.com/Abyys0/Bot-Infinity).

## API de salas: o que existe como evidência

O projeto Telegram Salas FF referencia `https://salasff.com.br` e contém um
cliente com as seguintes chamadas. São evidências de código de um terceiro,
**não documentação oficial validada nem garantia de que o serviço esteja ativo**.

| Operação no cliente | Caminho observado |
| --- | --- |
| Criar sala | `POST /api/v1/create:room` |
| Consultar sala | `POST /api/v2/info:room` |
| Iniciar sala | `POST /api/v2/start:room` |
| Checar sala | `POST /api/v2/check:room` |
| Expulsar participante | `POST /api/v2/expulsar-player` |

O cliente envia autenticação em um cabeçalho e utiliza `room_id` e `sshash` em
operações posteriores. Nosso código só deverá adotar esse contrato depois de
confirmá-lo com o provedor. Não foram feitas chamadas autenticadas nem criação
de salas durante esta pesquisa.

Fontes:

- [README do projeto Salas FF](https://github.com/Cajuz/bot_telegram-loop_salas/blob/7f843e42c1f3fa1665df655423ad6c3f9d976a22/README.md).
- [Cliente HTTP de salas](https://github.com/Cajuz/bot_telegram-loop_salas/blob/7f843e42c1f3fa1665df655423ad6c3f9d976a22/app/api_clients/freefire_client.py).
- [Política de tentativas do cliente](https://github.com/Cajuz/bot_telegram-loop_salas/blob/7f843e42c1f3fa1665df655423ad6c3f9d976a22/app/api_clients/base_client.py).
- [Serviço de criação de salas](https://github.com/Cajuz/bot_telegram-loop_salas/blob/7f843e42c1f3fa1665df655423ad6c3f9d976a22/app/services/room_service.py).
- [Códigos locais no projeto de mediação](https://github.com/gomes0499/freefire-bet-bot/blob/e0bc7ed92953764b162cf0b0218584edbf003ac9/discord-bot-python.py#L21).

### Condições para escolher um provedor

1. Documentação atual, suporte e autorização para oferecer o serviço.
2. Cobertura da região BR, modos, mapas e regras pretendidas.
3. Credencial de teste e uma criação real com ID/senha utilizáveis no jogo.
4. Preço, créditos, validade, cotas, simultaneidade e limite de requisições.
5. Consulta de pedido e prevenção de duplicidade após timeout.
6. Expiração, cancelamento, reembolso de falhas e disponibilidade.
7. Contrato de resposta e mensagens de erro verificáveis.

Não foi confirmada, nas fontes acessíveis, uma API oficial da Garena que garanta
salas ilimitadas. A expressão “salas infinitas” não será tratada como capacidade
técnica até verificar as condições do fornecedor. O plano suporta criação
recorrente dentro das cotas e um caminho manual quando necessário.

## Maiores servidores: conclusão ainda em aberto

Não há evidência suficiente nesta pesquisa para classificar os maiores servidores
de apostados ou identificar com segurança seus bots privados. Nome de organização,
número de estrelas no GitHub e texto promocional não provam tamanho ou uso real.

Para comparar servidores, faltam fontes públicas datadas com nome, convite/site,
membros, jogadores ativos, partidas concluídas e identificação do bot utilizado.
Não foram estimados faturamento, usuários ativos ou volume de apostas.

Google, Bing, DuckDuckGo, Discord, Disboard, Top.gg e o site SalasFF retornaram
`403` do proxy de rede. GitHub, conteúdo bruto e arquivos públicos do GitHub
estavam acessíveis. Logo, a pesquisa cobriu projetos públicos, mas não uma
varredura completa do mercado comercial nem o interior de servidores Discord.

Foi salvo um rascunho de rede com `www.google.com`, `discord.com`, `discord.gg`,
`disboard.org`, `top.gg` e `salasff.com.br`, preservando o preset de gerenciadores
de pacotes. Essa gravação não aplicou a política nem publicou o ambiente.
Para ampliar a pesquisa, é necessário revisar e salvar as alterações nas
configurações do ambiente e publicar; depois, repetir as consultas bloqueadas.

## Decisão de produto

O escopo posterior do cliente passou a priorizar criação/gerenciamento de salas,
com painel, banco e recuperação. IMAP, Mercado Pago e Efí são financeiros; não
identificam fornecedor de salas. Como ainda não há API escolhida, a alternativa
própria com emulador será avaliada por prova de conceito, sem presumir compatibilidade.
Referências Android e arquitetura em [docs/ROOM_AUTOMATION.md](docs/ROOM_AUTOMATION.md).
As ideias funcionais servem como
referência; código de terceiros não foi incorporado ao repositório.
O escopo e os critérios de entrega estão em [PLANO.md](PLANO.md).
