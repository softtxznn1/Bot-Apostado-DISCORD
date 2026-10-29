# Edição exclusiva de salas — desenvolvimento e operação

O produto do cliente usa `src/rooms/`. Os pontos de entrada padrão e os comandos
registrados são exclusivos de salas. Estado e pendências em [STATUS.md](STATUS.md).

## Instalar e validar

Requer Node.js 24. Na raiz do repositório:

```bash
npm ci
npm run check
npm run test:rooms
npm test
npm run demo
npm run doctor
```

`npm run verify:local` reúne typecheck, build/testes completos, demo e doctor e é
o mesmo fluxo executado pela integração contínua.

`test:rooms` valida a edição do cliente; `npm test` também verifica módulos antigos.
O demo usa SQLite temporário e provedor simulado persistente, sem acessar Discord
ou Free Fire. `doctor` informa presença de configuração sem revelar valores secretos.

Com as credenciais reais configuradas, use `npm run verify:connections`. A verificação
consulta aplicação/servidor/comandos no Discord e somente o catálogo na API de salas.
Não cria salas, registra comandos nem abre o banco do cliente. Retorna código 1
quando existe pendência; conexão confirmada ainda não representa homologação das
operações no jogo. O procedimento de aceite está em [docs/HOMOLOGACAO.md](docs/HOMOLOGACAO.md).

## Configuração do processo

Use `.env.example` como referência, sem sobrescrever um `.env` existente. Prefira
as configurações seguras da hospedagem; nunca envie tokens pelo chat.

| Variável | Uso |
| --- | --- |
| `DISCORD_TOKEN` | Token real do bot; também aceita `DISCORD_BOT_TOKEN` |
| `DISCORD_CLIENT_ID` | ID da aplicação para registrar comandos |
| `DISCORD_GUILD_ID` | Servidor autorizado onde serão registrados os comandos |
| `DATABASE_PATH` | Padrão `.data/rooms.sqlite`; use disco persistente |
| `ROOMS_PROVIDER` | `simulated` por padrão, ou `api` |
| `ROOMS_API_CONTRACT` | `room-management-v2`, somente após validar compatibilidade |
| `ROOMS_API_URL` | Origem HTTPS do fornecedor/gateway |
| `ROOMS_API_KEY` | Credencial secreta de salas |
| `ROOMS_API_AUTH_SCHEME` | `Bearer` ou `raw`, conforme contrato |
| `ROOMS_API_TIMEOUT_MS` | Padrão 10000, entre 100 e 60000 milissegundos |
| `ROOMS_HEALTH_FILE` | Heartbeat local gravável; padrão `/tmp/ff-salas-health.json` |
| `NODE_USE_ENV_PROXY` | Use 1 para respeitar o proxy do Node na hospedagem |

`ROOM_MODE`/`ROOM_API_*` pertencem ao contrato legado e não configuram a nova edição.
Credenciais PIX, IMAP ou de partidas não são necessárias nem inicializadas pelo bot.
IMAP/Mercado Pago/Efí pertencem a recebimentos. Os módulos financeiros anteriores
não estão conectados às salas. A finalidade agora é PIX avulso, sem créditos ou
liberação de salas. A orquestração independente ainda precisa ser implementada.

## Preparação de automação Android

Sem fornecedor escolhido, pode-se avaliar executor próprio junto ao emulador,
conforme [docs/ROOM_AUTOMATION.md](docs/ROOM_AUTOMATION.md). `npm run emulator:doctor`
consulta ADB, dispositivo autorizado, boot, pacote e resolução. Configuração:
`ROOMS_ADB_PATH`, `ROOMS_ANDROID_SERIAL` e `ROOMS_ANDROID_PACKAGE` no host do emulador.
O diagnóstico não instala/conecta o jogo nem envia comandos de toque ou criação.
Em produção compilada, use `node dist/src/rooms/emulator-doctor.js` no host com ADB.
O Docker do bot não inclui emulador/ADB, e o diagnóstico não é necessário para API.
O gateway/driver de criação ainda precisa ser implementado e validado na máquina real.

O Gateway Discord precisa de token utilizável em WebSocket. Placeholder substituído
apenas em HTTPS não equivale a essa credencial. Habilite escopos `bot` e
`applications.commands`; o bot usa apenas Guilds Intent, sem Message Content.

## Inicializar no Discord

```bash
npm run build
npm run register
npm start
```

`register` substitui os comandos DESTA aplicação no servidor informado, deixando
apenas `/sala` e `/salas`. Outros bots/servidores não são alterados. Comandos legados
podem ser restaurados explicitamente; não faça esse registro no servidor errado.
O processo precisa reiniciar após restauração/publicação; ele recupera os dados salvos.

1. Escolha canal do painel, canal de publicação e canal de logs opcional.
2. Conceda ao bot visualizar, enviar mensagens/embeds e ler histórico nesses canais.
3. Use `/salas configurar` com cargos operador/gerente/visualizador, limites,
   intervalo e listas de modos/mapas/extras desejadas. Omitir listas iniciais utiliza
   o catálogo fornecido pelo provedor. IDs desconhecidos e combinações inviáveis falham.
4. `/salas catalogo` mostra as opções disponíveis; `/salas cargos` ajusta vários cargos.
5. Publique o painel com `/salas painel`. Usuários autorizados escolhem modo/mapa,
   capacidade e extras. A prévia não mostra a senha nem chama criação antes da confirmação.
6. A resposta informa se a operação foi confirmada ou ficou pendente. Não repita a
   criação quando houver incerteza; consulte a sala salva no histórico.
7. Use `/sala consultar|status|atualizar|cancelar|encerrar`. Cancelar/encerrar exigem motivo
   e confirmação; o estado final só muda depois da confirmação do provedor.
8. `/salas minhas|historico` lista registros autorizados por página, criador e estado.
   `/salas sincronizar` reconcilia pedidos e informações desatualizadas.

Gerentes/admins usam `/salas diagnostico [pagina]` para conferir entregas por servidor,
sem payload ou senhas. `/salas reprocessar tarefa motivo` recupera somente tarefas
com tentativas esgotadas e registra auditoria permanente. Não repete escrita na
API de salas. Os novos subcomandos precisam ser registrados na aplicação do cliente.

## Saúde e encerramento

`npm run health` lê o heartbeat do processo em execução e retorna código 0 somente
com processo vivo, atualização recente, Gateway pronto e probe SQLite aprovado.
Sem processo iniciado retorna código 1. O probe lê a tabela de salas e testa a
entrada de escrita com um UPDATE sem linhas; não altera salas nem auditoria.
Esse resultado não comprova cotas, crédito, disponibilidade da API ou sala no jogo.

O heartbeat é escrito a cada dez segundos com permissão 0600, sem dados de sala
ou credenciais. A verificação recusa arquivo inválido, antigo, simbólico ou não
regular. O Docker utiliza a versão compilada desse healthcheck.

SIGINT/SIGTERM retira o heartbeat, interrompe novas tarefas e aguarda as operações
em voo antes de desconectar e fechar o banco. Prazo de 25 segundos: se excedido,
o processo sai com erro preservando operações já persistidas para reconciliação.
Não se fecha SQLite enquanto há trabalho em execução. O Compose aguarda 30 segundos.

Leituras de reconciliação usam um lote de até dez com no máximo três simultâneas,
priorizando a consulta mais antiga. API lenta não bloqueia a entrega no Discord.
Uma confirmação assíncrona entra na outbox e pode ser publicada no próximo ciclo.

## Permissões e publicação

Administradores configuram. Gerentes gerenciam todas as salas do servidor.
Operadores criam e gerenciam as próprias salas. Visualizadores consultam informações
sem senha. Cada clique revalida cargos; respostas privadas revalidam o membro após
operações assíncronas para não entregar segredos depois de uma revogação.

O canal de publicação deve estar restrito aos cargos configurados. O bot verifica
as permissões, sem reescrever silenciosamente a configuração do canal. Senha é
exibida ao criador autorizado/gerência em resposta privada. No canal compartilhado
com operadores ou visualizadores, o embed omite senha; canais exclusivamente
permitidos à gerência podem incluí-la. Permissões administrativas do Discord
continuam prevalecendo. Mudanças de destino removem os dados da publicação antiga.

ID/mensagem são persistidos, com recuperação após exclusão/interrupção. Logs e
histórico não incluem senha. Falha de publicação reenvia a mensagem e não cria
outra sala. A publicação só utiliza uma resposta de sala validada e confirmada.

## API e catálogo

O provedor simulado possui modos e mapas marcados DEMONSTRAÇÃO; não cria salas no
jogo. No modo `api`, o cliente exige as operações obrigatórias e o contrato descrito
em [ROOM_API_V2.md](docs/ROOM_API_V2.md). Ele não presume compatibilidade com Storm Salas
ou Garena. Um gateway/adaptador precisa traduzir o contrato real do fornecedor.

As opções extras usam tipos, limites, listas permitidas e editabilidade do catálogo.
Defaults retornados pela API só são aceitos quando conhecidos e tipados. Campos
solicitados não podem ser silenciosamente alterados. O estado aplicado fica salvo,
incluindo a configuração original da operação sem senha na auditoria pública.

Escritas têm referência estável e não são repetidas após timeout. Recuperação usa
consulta por referência/ID. Uma sala já encerrada/expirada durante recuperação é
registrada com seu estado real, sem pendência eterna nem falso anúncio de disponibilidade.

## Persistência e operação

SQLite usa migrações versionadas, salas independentes, operações e eventos
append-only. Use uma instância do bot sobre o banco. Não substitua banco aberto.
Preserve arquivos e backups. O padrão novo `rooms.sqlite` não apaga o banco legado.

O bot reconcilia periodicamente estados, painel e publicações. A outbox separa seus
tipos de tarefa dos legados, com leases e backoff. Não reenvia escritas de criação,
edição ou encerramento para recuperar uma publicação que falhou.

```bash
npm run backup
```

Backup inclui WAL, valida integridade e não sobrescreve destinos existentes.
Veja [DEPLOY.md](docs/DEPLOY.md) para Docker, persistência e restauração.

## Módulos preservados fora do produto

Entradas antigas são explícitas: `legacy:start`, `legacy:register`, `legacy:demo`,
`legacy:web` e `legacy:webhooks`. Não são parte da entrega nem devem ser ativadas
no servidor do cliente por padrão. Documentos antigos de PIX/partidas se referem a
esses módulos. Nenhuma configuração bancária bloqueia `npm start` da edição de salas.

Homologação exige credenciais, backend real com operações comprovadas (fornecedor
ou executor próprio), servidor Discord de teste e entrada nas salas reais do Free Fire.
