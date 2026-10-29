# Progresso da edição de salas

**80,00% do roteiro de implementação: 8 de 10 marcos concluídos localmente.**
O acompanhamento abaixo corresponde ao escopo exclusivo do cliente e substitui
as estimativas do projeto de apostados. A operação real aguarda os dois últimos marcos.
**Os oito marcos locais estão concluídos e validados.** Os dois marcos externos
continuam exigindo backend real e acesso ao ambiente do cliente.

| Marco | Entrega verificável | Estado |
| --- | --- | --- |
| 1 | Entidade independente de sala, operações e histórico persistentes | Concluído e testado |
| 2 | Configuração por servidor, cargos atuais, canais, limites e isolamento | Concluído e testado |
| 3 | Catálogo de modos/mapas, capacidade, extras tipados e campos editáveis | Concluído e testado |
| 4 | Painel, menus paginados, formulários, prévia, confirmação e correção de erros | Concluído e testado |
| 5 | Cliente HTTP de criação, consulta, edição, cancelamento e encerramento | Implementado e testado contra servidor HTTP local |
| 6 | Embeds, atualização da mensagem, proteção de senha e controle de permissões | Concluído com transporte Discord simulado |
| 7 | Idempotência, pedidos incertos, reinício, defaults da API e outbox | Concluído e testado |
| 8 | Edição exclusiva, comandos dedicados, demo, backup e configuração de execução | Concluído e testado |
| 9 | Selecionar e validar backend real: API compatível ou executor próprio com emulador | Pendente: fornecedor ou máquina/conta para prova de conceito |
| 10 | Homologar no Discord e Free Fire usando salas reais | Pendente: credenciais e ambiente do cliente |

## Evidência desta entrega

- **149 testes específicos de salas passaram**, cobrindo domínio, UI, HTTP,
  permissões, operações, saúde, diagnóstico Android, conexões e entradas.
- **302 testes do projeto inteiro passaram**, preservando também a base legada.
- O demo cria, consulta, edita, encerra e cancela salas simuladas e reabre o SQLite
  para conferir a preservação de salas/histórico. Não cria partida, fila ou pagamento.
- A imagem Docker compilou e executou o demo sem root, com filesystem somente
  leitura, backup íntegro e inicialização protegida quando falta token. Compose
  foi verificado para ativar somente o serviço de salas por padrão.
- O cliente HTTP completo foi exercitado com servidor local controlado; isso não
  certifica compatibilidade com a API da Storm Salas nem com qualquer fornecedor.
- Os testes do Discord usam transporte simulado. Não houve login no servidor do
  cliente nem entrada em uma sala real do Free Fire nesta validação.

## Melhorias após os oito marcos locais

- Edição por painel coleta opções obrigatórias do novo modo, preservando a
  imutabilidade depois de aplicada a mudança. Formulários aceitam inteiros seguros.
- HTTP 429 respeita `Retry-After` e bloqueia novas requisições durante a pausa,
  sem repetir escritas. Recuperação por referência continua preservada.
- Histórico encerrado é verificado em lotes de dez e em intervalos de cinco
  minutos; painéis estáveis, a cada minuto. Publicações ativas mantêm checagem de
  acesso a cada quinze segundos. Intervalos são mínimos e dependem da fila/rede.
- `npm run verify:connections` consulta aplicação, servidor, comandos e catálogo,
  sem alterar o Discord, abrir o banco ou criar salas. Sem credenciais, terminou
  corretamente com código 1 e pendências explícitas. Testes com transporte
  controlado passaram; nenhuma conexão real foi certificada.
- [Roteiro de homologação](docs/HOMOLOGACAO.md) preparado para o aceite do cliente.

## Fechamento da etapa local

- Cancelar rascunho funciona mesmo com o fornecedor indisponível e libera a vaga
  local. Limites inteiros assinados do catálogo e seleção do último snapshot foram
  corrigidos, inclusive quando o relógio retrocede ou operações têm a mesma data.
- Reconciliação em segundo plano, em lotes de dez e com três leituras simultâneas,
  dá prioridade à consulta mais antiga. Pedidos além do primeiro lote continuam
  sendo consultados; API lenta não bloqueia entregas e verificações de acesso.
- `/salas diagnostico` e `/salas reprocessar` permitem à gerência recuperar
  entregas esgotadas do próprio servidor com auditoria, sem repetir escritas na API.
  Recuperação completa de uma publicação após oito falhas foi testada com apenas
  uma criação de sala e o mesmo ID remoto. Novas versões da sala podem originar
  novas entregas; o reprocessamento explícito atende também histórico estável.
- Healthcheck com heartbeat privado/atômico, estado do Gateway e probe SQLite
  detecta processo parado, snapshot antigo, desconexão e banco sem escrita, sem
  alterar salas. A verificação recusa links, FIFOs e arquivos inválidos sem bloquear.
  Não atesta cotas, API disponível ou sala existente no jogo.
- Encerramento concorrente aguarda trabalho em voo antes de fechar SQLite; prazo
  de 25 segundos evita parada indefinida. Pendências persistidas continuam para
  reconciliação no próximo início. O Compose concede 30 segundos ao processo.
- `npm run verify:local` passou com typecheck, build, 302 testes, demo e doctor.
  A integração contínua usa esse comando. Docker foi recompilado e testado sem root,
  com raiz somente leitura, backup, CLI de conexão e novo healthcheck compilado.
- [Guia do cliente](GUIA_CLIENTE.md) e documentação de operação/aceite atualizados.

Essas melhorias reforçam os marcos existentes. O percentual permanece em 80%:
os marcos 9 e 10 dependem de evidência com o backend escolhido e os serviços reais.

## Alternativa de automação própria

O usuário não possui fornecedor de salas definido e sugeriu automação por emulador.
O plano agora contempla API comercial ou gateway próprio junto ao Android.
`npm run emulator:doctor` foi implementado com consultas ADB de leitura, seleção
de dispositivo, boot, pacote do jogo e resolução. Quatorze testes novos passaram.
Neste ambiente o comando encerrou com código 1 e `ANDROID_ADB_MISSING`, sem tentar
instalar, conectar contas ou criar salas. Os testes com dispositivo usam respostas
controladas e um executável de fixture; não houve Free Fire real nesta validação.

O diagnóstico não implementa o executor do jogo. São necessários máquina/emulador,
conta, inspeção das telas e prova de conceito. IMAP, Mercado Pago e Efí pertencem
a pagamentos, conforme esclarecido pelo usuário; não são APIs de salas.

## Produto entregue no código

`npm start`, `npm run dev` e `npm run register` usam a edição de salas. Ela registra
somente `/sala` e `/salas`, sem inicializar PIX, filas competitivas ou partidas.
Os módulos anteriores foram preservados e só possuem entrada explícita `legacy:*`.

O padrão é `ROOMS_PROVIDER=simulated`, com identificação de demonstração nos dados.
O modo `api` exige contrato `room-management-v2`, credencial e capacidades completas.
Modos, mapas e opções de demonstração não são apresentados como catálogo oficial.

Senhas só aparecem ao criador autorizado/gerência em resposta privada ou em canal
que não as exponha a outros operadores/visualizadores. Histórico e logs omitem
senhas; canais compartilhados recebem publicação sem o segredo. Canais públicos
precisam ter o acesso revisto antes da publicação restrita de salas.

## O que falta para o aceite real

1. Escolher API de fornecedor ou executor próprio junto a um emulador.
2. Na opção API: documentação/acesso, região, cotas e créditos. Na opção própria:
   máquina, emulador, jogo/conta e prova de conceito com as telas reais.
3. Token e IDs Discord configurados no ambiente, com canais/cargos de teste.
4. Executar o roteiro completo no Discord e conferir ID/senha, opções e estado no jogo.

Arquitetura e preparação em [docs/ROOM_AUTOMATION.md](docs/ROOM_AUTOMATION.md).
O diagnóstico ADB não implementa ações no jogo. Não houve criação via emulador.
Se o contrato do fornecedor diferir do contrato HTTP implementado, será necessário
adaptar a integração antes do aceite. Uma operação obrigatória ausente no fornecedor
continua sendo pendência; cancelar somente o registro local não equivale a cancelar
uma sala no Free Fire. A referência funcional Storm Salas não implica acesso à sua API.

IMAP, Mercado Pago e Efí foram esclarecidos como recebimentos financeiros, sem
relação com criação de salas. Os adaptadores PIX anteriores ainda estão ligados a
partidas e não foram ativados na edição de salas. O usuário confirmou **PIX avulso**:
a próxima integração financeira será independente de partidas, salas e créditos.
Ela ainda precisa ser implementada; não houve cobrança bancária real.
Carteiras de apostas, prêmios e análises não foram reintroduzidos.

A recomendação de menor esforço para terminar é API comercial de salas e bot em
hospedagem leve. [VIABILIDADE.md](docs/VIABILIDADE.md) registra custos documentados,
candidatos ainda não homologados e comparação com emulação. Não há orçamento
completo nem fornecedor escolhido; o percentual de salas não foi aumentado.
