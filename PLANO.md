# Plano do cliente — criação e gerenciamento de salas Free Fire

## Objetivo e escopo vigente

Entregar um bot Discord dedicado a criar e gerenciar salas de Free Fire por API
de fornecedor ou gateway próprio com executor em emulador, após prova de conceito,
com painel interativo, opções configuráveis, publicação organizada e histórico.
A Storm Salas é a referência de experiência indicada pelo cliente. Não há
especificação técnica verificada desse sistema; não se presume acesso à sua API,
ao seu código ou a recursos não descritos pelo cliente.

O núcleo atual substitui o plano anterior de apostados e não depende de
fila de jogadores, partida, mediador, resultado ou pagamento. O usuário esclareceu
que IMAP, Mercado Pago e Efí pertencem a recebimentos financeiros. Pagamentos são
um módulo separado de **PIX avulso**, conforme confirmado pelo usuário;
não fornecem a criação de salas. Carteira de apostas, prêmios, ranking competitivo,
tickets e análises não foram reintroduzidos. O código existente desses módulos permanece
preservado; os pontos de entrada padrão e o registro de comandos já usam somente a edição
de salas. Entradas `legacy:*` mantêm o código antigo disponível separadamente.

## Requisitos recebidos e melhorias incorporadas

| ID | Pedido do cliente | Implementação e pendência de validação |
| --- | --- | --- |
| R01 | Painel com botões e menus para configurar/criar salas | Implementado: painel exclusivo, menus paginados, formulário, prévia e confirmação |
| R02 | Escolher modo, mapa, quantidade de jogadores e outras opções | Implementado: catálogo dinâmico, capacidade, extras tipados, whitelists e editabilidade |
| R03 | Embed com ID, senha, modo e demais informações | Implementado: embed próprio, proteção de senha por acesso e atualização da mensagem existente |
| R04 | Criar, cancelar, consultar e encerrar salas | Implementado no domínio e cliente HTTP completo; homologação do fornecedor real pendente |
| R05 | Atualizar informações e verificar estado pela API | Implementado com consulta/edição e reconciliação por HTTP; confirmar contrato real da API |
| R06 | Configurar canais de envio, cargos e opções de criação | Implementado por servidor: painel/publicação/logs, vários cargos, catálogo e limites |
| R07 | Registrar todas as salas e preservar histórico após reinício | Implementado: entidade independente, operações, eventos, dados aplicados e mensagens persistidos |
| R08 | Integração segura, erros tratados e confirmação antes de publicar | Implementado e testado localmente: TLS, validação, idempotência, revogação e incertezas |
| R09 | Sistema organizado, automatizado e fácil de configurar | Implementado: assistente, configuração persistente, sincronização e recuperação; presets opcionais ficam como melhoria |
| R10 | Apenas funcionalidades de criação e gerenciamento de salas | Implementado: entrada padrão e registro exclusivos, módulos de apostados isolados em legacy:* |

O contrato legado `RoomProvider` continua restrito a criação/recuperação de partidas.
A edição nova usa `ManagedRoomProvider`, com criação, consulta, atualização,
cancelamento e encerramento por HTTP. Testes locais verificam essas operações;
o backend real ainda precisa ser escolhido e implementado/validado. O gateway
próprio é uma alternativa ao fornecedor externo, não uma automação já concluída.
Arquitetura e critérios em [docs/ROOM_AUTOMATION.md](docs/ROOM_AUTOMATION.md).
Para custo baixo e entrega rápida, a recomendação atual é API comercial compatível
com hospedagem leve, deixando o emulador como alternativa. Comparação, preços
documentados e sequência de implementação em [docs/VIABILIDADE.md](docs/VIABILIDADE.md).

PIX avulso terá cobranças próprias, independentes de partidas e salas. Não vender
créditos nem condicionar criação de sala ao pagamento. O núcleo atual de salas
continua funcional sem credenciais bancárias; a integração avulsa ainda será implementada.

## Experiência no Discord

### Configuração administrativa

1. Administração escolhe canal do painel, canal de publicação e canal de logs.
2. Define cargos de operador, gerente e visualização das informações sensíveis.
3. Vincula fornecedor ou gateway próprio por configuração segura; tokens não são digitados em comandos.
4. Habilita modos, mapas, limites de jogadores e opções reconhecidas pela API.
5. Define limites de criação por usuário/servidor e simultaneidade dentro da cota
   contratada. Nenhuma promessa de salas ilimitadas sem confirmação do fornecedor.
6. Publica o painel e verifica o acesso do bot aos canais escolhidos.

A configuração tem isolamento por servidor. Configurações financeiras e
credenciais Mercado Pago/Efí/IMAP não são pré-requisitos desta entrega.

### Painel de salas

- Botões principais: **Criar sala**, **Minhas salas**, **Consultar sala** e
  **Atualizar lista**. Configuração fica disponível somente à administração.
- **Criar sala** abre seleção de modo e mapa, capacidade e formulário dos demais
  campos disponíveis. Exemplos de campos condicionais: nome, senha, região e regras.
- O catálogo vem da documentação ou da API do fornecedor. Não inventar mapas,
  modos ou combinações; não limitar todos os modos a 1x1–4x4 por herança das filas.
- Menus respeitam os limites do Discord, usando páginas ou filtros quando preciso.
- A prévia mostra opções selecionadas e canal de destino. A confirmação valida
  novamente cargo, canal, limites e compatibilidade das opções antes da requisição.
- Durante a criação, exibir andamento e impedir cliques repetidos com novos efeitos.
- Se houver resposta incerta, informar pendência e consultar a referência; não
  gerar automaticamente uma segunda sala.
- Presets de criação são melhoria opcional após os requisitos obrigatórios.

### Publicação e controles da sala

Após confirmação verificável do provedor, publicar um embed com:

- Nome/referência da sala e ID utilizável no jogo.
- Senha, quando exigida, conforme a política de acesso do canal configurado.
- Modo, mapa, capacidade, região e demais opções aplicadas disponíveis.
- Criador responsável, estado confirmado e horário da última sincronização.
- Validade/expiração, quando informadas pelo provedor.

Distinguir opções solicitadas de opções confirmadas. Nunca anunciar uma opção
ignorada pela API como aplicada. Resposta assíncrona requer consulta até confirmar
criação; receber HTTP 2xx ou gerar um número local, isoladamente, não basta.

O embed possui **Consultar/Atualizar estado**, **Editar**, **Cancelar** e
**Encerrar**, conforme o estado e as permissões. Cancelar/encerrar exigem
confirmação contextual e motivo para auditoria. Revalidar permissões em cada
clique, inclusive em mensagens antigas e após mudança de cargos.

Atualizar a mensagem existente em vez de publicar duplicatas a cada consulta.
Falha ao publicar reenvia somente a mensagem, sem chamar criação novamente.

## Comandos da edição de salas

Os comandos abaixo já estão implementados na edição exclusiva; a homologação
com o provedor real permanece pendente.

| Comando | Resultado esperado |
| --- | --- |
| `/salas configurar` | Define canais, cargos, limites e opções permitidas por servidor |
| `/salas painel` | Publica ou restaura o painel de criação no canal configurado |
| `/sala criar` | Abre formulário ou cria usando opções validadas; independente de partida |
| `/sala consultar` | Consulta detalhes da sala na API e atualiza a visualização autorizada |
| `/sala status` | Obtém estado remoto e informa a última sincronização confirmada |
| `/sala atualizar` | Altera campos permitidos pela API e sincroniza o embed após confirmação |
| `/sala cancelar` | Solicita cancelamento remoto nas condições admitidas pelo fornecedor |
| `/sala encerrar` | Solicita encerramento remoto da sala, preservando o histórico |
| `/salas minhas` | Lista salas acessíveis do solicitante, com paginação e filtros |
| `/salas historico` | Consulta histórico por criador, data e estado, com isolamento por servidor |
| `/salas sincronizar` | Equipe reconcilia pendências e salas cujo estado ficou desatualizado |
| `/salas diagnostico` | Gerência consulta entregas e falhas do servidor, sem segredos |
| `/salas reprocessar` | Gerência recupera entrega esgotada com motivo auditado, sem repetir escrita na API |

`Consultar/status` são leituras; `atualizar` altera a sala no provedor. Mudar
configuração ou preset afeta criações futuras, sem editar salas existentes.
Iniciar sala por API pode ser acrescentado se solicitado e suportado, sem
substituir os requisitos obrigatórios de cancelar e encerrar.

## Integração e operações obrigatórias da API

Antes do adaptador definitivo, confirmar com o fornecedor ou comprovar no executor:

1. Autenticação, região, cotas, disponibilidade e documentação atual.
2. Modos, mapas, capacidade mínima/máxima, opções, valores padrão e incompatibilidades.
3. Identificador estável da solicitação, ID remoto, senha e confirmação de criação.
4. Consulta por ID e recuperação por referência após perda de resposta.
5. Cancelamento, encerramento e atualização: endpoints, campos mutáveis e estados
   em que cada operação é aceita; confirmar se são ações distintas ou o mesmo endpoint.
6. Estados canônicos, expiração, consulta periódica e eventos/webhooks disponíveis.
7. Idempotência, limites de frequência e erros que garantem ausência de efeito remoto.

O adaptador deverá expor criação, consulta, consulta por referência, edição,
cancelamento e encerramento, traduzindo o contrato real do fornecedor. Um catálogo
de capacidades pode vir de endpoint ou de configuração validada pela documentação.
Não enviar JSON arbitrário fornecido pelo usuário à API.

Se a API não oferecer uma operação obrigatória, a escolha do provedor ou uma
alternativa técnica precisa ser resolvida. Desabilitar um botão ou encerrar só
um registro local não cumpre esse requisito e não autoriza chamar a entrega de completa.

## Estados e recuperação

| Situação | Comportamento esperado |
| --- | --- |
| Rascunho | Editar opções sem criar recurso no jogo |
| Criação pendente | Persistir referência antes do envio e aguardar confirmação |
| Sala criada/disponível | Exibir dados confirmados e permitir ações compatíveis |
| Em andamento | Usar apenas se esse estado puder ser confirmado pelo fornecedor |
| Atualização/cancelamento/encerramento pendente | Registrar operação e aguardar resultado remoto antes de alterar o estado confirmado |
| Cancelada/encerrada/expirada | Preservar histórico e impedir ações incompatíveis |
| Falha definitiva | Informar erro conhecido sem fingir sucesso ou apagar a ocorrência |
| Sincronização incerta | Preservar último estado confirmado, marcar dados desatualizados e reconciliar |

- Cada operação tem referência e chave de idempotência estáveis e exclusão de
  operações conflitantes sobre a mesma sala.
- Nunca repetir uma escrita apenas porque houve timeout. Consultar o provedor
  primeiro; sem recuperação verificável, manter pendência para a equipe resolver.
- Repetir leituras com backoff e limites; respeitar `Retry-After` quando aplicável.
- Validar corpo/tamanho, campos essenciais, associação ao pedido e identidade do
  provedor. Nunca aceitar status arbitrário de webhook sem verificação adequada.
- Verificar estados reais depois de editar, cancelar ou encerrar. Não anunciar
  cancelamento/encerramento enquanto a confirmação continuar pendente.
- Ao reiniciar, retomar operações e sincronização; não recriar salas já confirmadas.
- Reaproveitar outbox e vínculos de mensagens para recuperação de entregas.

## Banco de dados e privacidade

| Entidade | Dados principais |
| --- | --- |
| Configuração de salas por servidor | Canais, cargos, limites, catálogo permitido e vínculo do provedor |
| Sala independente | UUID local, servidor, criador, referência, ID remoto, opções solicitadas/aplicadas, último estado confirmado, validade e datas |
| Dados privados da sala | Senha e outros dados de entrada com acesso restrito; proteção do banco e de backups |
| Operação de sala | Tipo, referência/idempotência, autor, status, tentativas e confirmação remota |
| Evento de auditoria | Ação, ator, horário, motivo e alterações relevantes, sem senha/token |
| Publicação | Canal, mensagem, estado da entrega e última atualização |
| Preset opcional | Nome e opções validadas para novas criações |

Sala não fica mais subordinada a `Match`, reservas de jogadores ou plano financeiro.
Toda consulta usa servidor e autorização do solicitante. Senhas não entram em
logs, auditoria pública ou histórico de quem não tem acesso. O histórico mantém
as operações mesmo após encerramento e reinício, com paginação e retenção definida.

## Execução por etapas

| Etapa | Trabalho | Evidência de conclusão |
| --- | --- | --- |
| 1 — Contrato | Mapear requisitos à documentação e testar capacidades do provedor | Todas as operações obrigatórias têm suporte confirmado |
| 2 — Domínio | Entidade independente de sala, configurações, migrações e permissões | Criar/consultar registro sem partida, fila ou pagamento |
| 3 — Painel | Menus, formulário, catálogo, prévia e configuração por servidor | Seleção completa de modo/mapa/capacidade com validação |
| 4 — Criação | Integração real, confirmação e embed de sala | Dados permitem entrar na sala no Free Fire |
| 5 — Gestão | Consulta, atualização, cancelamento e encerramento | Operações alteram o recurso remoto e o embed corretamente |
| 6 — Recuperação | Outbox, idempotência, reinício, histórico e erros | Falhas/repetições não duplicam salas nem perdem dados |
| 7 — Entrega | Edição de salas, documentação, backup e homologação | Comandos do cliente disponíveis; módulos alheios ao escopo não registrados |

Reutilizar Node.js/TypeScript, discord.js, SQLite, infraestrutura de auditoria,
outbox, backup e implantação. Ajustar o contrato atual de salas sem presumir que
`room-contract-v1` já atende mapa, capacidade ou gerenciamento remoto.

## Critérios de aceite do cliente

- Criar uma sala diretamente pelo painel, sem iniciar fila, partida ou cobrança.
- Selecionar modo, mapa, capacidade e opções liberadas, sem aceitar combinações
  inválidas nem substituir opções silenciosamente.
- Publicar ID/senha somente após confirmação documentada de criação.
- Entrar no Free Fire usando os dados retornados e conferir a configuração da sala.
- Consultar estado real e atualizar o mesmo embed com data de sincronização.
- Editar opção mutável e comprovar a alteração no provedor e na mensagem.
- Cancelar e encerrar salas reais nas condições combinadas, sem confundir ação
  local com confirmação remota.
- Configurar canais/cargos por servidor; impedir uso por cargo removido, botões
  antigos e acesso cruzado entre servidores.
- Preservar configuração, sala, histórico e mensagens após reinício.
- Timeout/repetição não duplica criação; falha de envio não cria outra sala.
- API indisponível não faz aparecer falso sucesso nem estado antigo como atualizado.
- Histórico paginado respeita filtros e não revela senhas sem autorização.
- Edição do cliente registra somente comandos de criação/gerenciamento de salas
  e não exige credenciais de pagamentos ou módulos de apostados.
- Executar testes de domínio, contrato HTTP e permissões e homologação no Discord
  e Free Fire. Distinguir resultados locais dos testes com serviços reais.

## Dependências e situação atual

Para fechar o backend real, definir API de fornecedor ou máquina com emulador para
prova de conceito. O cliente ainda não escolheu fornecedor; não exigir uma documentação
que ele não possui. Na opção emulador, faltam máquina, jogo/conta e inspeção das telas.
Ambas as opções precisam de credenciais seguras e servidor Discord de teste. Confirmar com o cliente
apenas o que a API/documentação não resolver, como padrões de criação e canais/cargos.
Não é necessário aguardar essas escolhas para estruturar domínio, painel e testes.

A edição exclusiva foi implementada em `src/rooms/`, com painel, domínio próprio,
CRUD HTTP, histórico, segurança e recuperação testados localmente. O acompanhamento
agora usa os 10 marcos de [STATUS.md](STATUS.md): 8 concluídos (80% do roteiro),
com backend real (fornecedor ou executor próprio) e homologação ainda pendentes. Estado do código em [STATUS.md](STATUS.md); operação da base existente em
[DESENVOLVIMENTO.md](DESENVOLVIMENTO.md).
