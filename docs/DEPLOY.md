# Implantação e backup — edição de salas

## Preparação

Use Node.js 24. Configure token/IDs Discord e o provedor em um `.env` protegido
ou no gerenciador seguro da hospedagem. Credenciais financeiras não são necessárias.
O `.env` e certificados não entram no contexto de build nem na imagem.

```bash
npm ci
npm run verify:local
npm run build
npm run register
npm run verify:connections
npm start
```

O padrão é demonstração identificada, sem sala no jogo. Para produção, valide o
contrato do fornecedor antes de ativar `ROOMS_PROVIDER=api`. Um processo conectado
ou um contêiner em execução não comprova criação real no Free Fire.

## Docker Compose

A imagem usa Node 24, build separado, dependências de produção e usuário não-root.
O serviço padrão é somente o bot de salas, com volume persistente, filesystem
somente leitura e diretório temporário isolado. O banco é `/app/.data/rooms.sqlite`.

```bash
docker compose build
docker compose run --rm bot node dist/src/rooms/register.js
docker compose run --rm bot node dist/src/rooms/verify.js
docker compose up -d bot
docker compose logs --tail=100 bot
```

O `.env` precisa existir antes de usar Compose. O registro substitui os comandos
desta aplicação no servidor indicado. Não imprima `docker compose config` nem
inspeções completas: valores secretos podem aparecer nessas saídas.

O dashboard antigo tem perfil explícito `legacy`, desativado por padrão. Não é
parte da entrega do cliente. O volume/banco antigo não é apagado pela nova edição.
Use uma instância do bot e preserve a propriedade/permissões do volume de dados.

Em uma hospedagem com proxy HTTPS e CA própria, o build aceita BuildKit secret
`--secret id=build_ca,src=/caminho/ca-confiavel.pem` e os argumentos padrão
`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`. Use somente a CA pública confiável da
hospedagem, sem desativar TLS. A CA temporária do build não fica na imagem e não
configura o runtime: se necessário, monte a CA confiável no processo em execução.
`NODE_USE_ENV_PROXY=1` permite respeitar o proxy do Node; confirme o suporte ao
Gateway WebSocket e à API na rede real antes da homologação.

## Verificação após iniciar

1. Conferir evento `rooms_ready` com a edição/provedor esperados.
2. Configurar cargos/canais e publicar o painel.
3. Criar uma sala com modo/mapa/capacidade e verificar confirmação e embed.
4. Entrar no jogo usando ID/senha e conferir as opções aplicadas.
5. Consultar, editar, cancelar/encerrar e verificar o efeito real.
6. Reiniciar o processo e conferir salas, histórico e mensagens recuperadas.

## Monitoramento e recuperação

```bash
npm run health
docker compose exec bot node dist/src/rooms/healthcheck.js
```

O healthcheck confere processo, heartbeat recente, Gateway e acesso SQLite, sem
consultar o fornecedor ou declarar salas reais validadas. O heartbeat usa o arquivo
`ROOMS_HEALTH_FILE` (padrão `/tmp/ff-salas-health.json`), renovado a cada dez segundos.
Mantenha esse caminho gravável no tmpfs. A imagem verifica saúde a cada 30 segundos,
com 60 segundos iniciais e três falhas antes de marcar `unhealthy`.

Docker Compose não reinicia um contêiner apenas por ele estar `unhealthy`; configure
alerta/supervisão da hospedagem. `restart: unless-stopped` atua quando o processo sai.

No Discord, `/salas diagnostico` mostra falhas restritas ao servidor. Corrigir o
canal/permissões e usar `/salas reprocessar tarefa motivo` para recuperar entrega
esgotada. A recuperação é auditada e não repete operações da API de salas.

SIGTERM/SIGINT interrompe novos trabalhos e aguarda os já iniciados. O processo
tem prazo de 25 segundos antes de sair com erro; o Compose concede 30 segundos.
Operações incertas persistidas são reconciliadas no próximo início, sem reenvio
automático da escrita. API lenta é consultada em segundo plano e não bloqueia as
verificações de acesso das publicações.

Para encerrar, use SIGTERM/SIGINT; não apague o banco para corrigir configuração.
Os testes/demos locais não substituem esse roteiro com os serviços do cliente.
Use [HOMOLOGACAO.md](HOMOLOGACAO.md) para registrar os resultados do aceite.

## Backup consistente

Não copie apenas o arquivo principal enquanto SQLite usa WAL. O backup online
inclui transações confirmadas, valida integridade e publica um novo arquivo com
permissão 0600, sem sobrescrever um destino existente.

```bash
npm run backup
npm run backup -- .data/backups/antes-da-atualizacao.sqlite
docker compose exec bot node dist/src/backup.js
```

O padrão usa `DATABASE_PATH` ou `.data/rooms.sqlite`. Backups ficam em `.data/backups`
com nome único; exporte para armazenamento externo protegido. O arquivo contém
histórico e dados privados das salas. Nunca o versione ou publique.

## Restauração controlada

1. Fazer backup validado do estado atual e confirmar sua cópia externa.
2. Parar o bot antes de substituir qualquer arquivo SQLite.
3. Abrir a cópia candidata e conferir `PRAGMA integrity_check` e os registros esperados.
4. Preservar o banco anterior e seus arquivos WAL/SHM em local protegido.
5. Restaurar a cópia validada com o dono/permissões do processo, sem reutilizar WAL
   ou SHM de outro banco.
6. Reiniciar e conferir configuração, histórico, estados e publicação.

Não há restauração automática destrutiva. Os testes abrem uma cópia temporária
restaurada sem alterar arquivos do usuário.
