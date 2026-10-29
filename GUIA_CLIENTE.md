# Uso do bot de salas

## Configuração inicial pela administração

1. Criar ou escolher os canais do painel, das salas e dos registros.
2. Dar ao bot acesso de visualização, envio de embeds e leitura de histórico.
3. Separar cargos de operadores, gerentes e visualizadores.
4. Usar `/salas configurar` para selecionar canais/cargos, limites e opções.
5. Consultar `/salas catalogo` e publicar o painel com `/salas painel`.

Operadores criam e gerenciam as próprias salas. Gerentes gerenciam as salas do
servidor. Visualizadores consultam informações sem receber senhas. A administração
configura o bot. `/salas cargos` permite adicionar/remover cargos de cada grupo.

O canal de salas precisa ser restrito aos cargos configurados. Em canais
compartilhados entre operadores ou visualizadores, a senha fica disponível na
resposta privada do criador autorizado ou da gerência. O bot confere permissões
sem alterá-las automaticamente.

## Criar e gerenciar

No painel, clicar em **Criar sala**, escolher modo/mapa, informar capacidade e
opções, revisar a prévia e confirmar. `/sala criar` abre o mesmo assistente.
O bot só apresenta os dados de entrada depois da confirmação do fornecedor.

- `/salas minhas`: localizar suas salas e copiar a referência interna.
- `/sala consultar` ou `/sala status`: conferir dados e estado atualizado.
- `/sala atualizar`: abrir o assistente de edição dos campos permitidos.
- `/sala cancelar`: solicitar cancelamento com motivo e confirmação.
- `/sala encerrar`: solicitar encerramento e manter o histórico.
- `/salas historico`: listar registros autorizados, com página e filtros.
- `/salas sincronizar`: consultar novamente uma sala e reconciliar pendências.

Os comandos de gestão recebem a referência interna exibida pelo bot. Ela é
diferente do ID usado para entrar na sala no jogo.

Se aparecer **pendente de confirmação**, consultar a sala existente. Não criar
outra para repetir a tentativa: a solicitação anterior pode ter sido processada.
Cancelar um rascunho é uma ação local; cancelar/encerrar uma sala confirmada
depende da confirmação remota do fornecedor.

## Recuperar publicação com falha

A gerência usa `/salas diagnostico` para ver as tarefas deste servidor. Depois de
corrigir o canal ou as permissões, pode usar `/salas reprocessar` com a referência
da tarefa esgotada e o motivo. O bot registra a recuperação em auditoria.

Essa ação recupera a entrega no Discord. Ela não cria novamente a sala, não
reenvia alterações ao fornecedor e não interrompe tarefas que estejam em execução.

## Conferência da entrega

Salas identificadas como **SIMULAÇÃO/DEMONSTRAÇÃO** não existem no Free Fire.
A operação real depende do fornecedor configurado e da validação de ID/senha e
opções dentro do jogo. A equipe técnica deve executar o
[roteiro de homologação](docs/HOMOLOGACAO.md) antes do aceite de produção.
