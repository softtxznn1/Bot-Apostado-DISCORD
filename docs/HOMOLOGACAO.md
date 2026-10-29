# Aceite com Discord e salas reais

Este roteiro ainda precisa ser executado no ambiente do cliente. Testes locais,
catálogo consultável e conexão ao Discord não comprovam funcionamento no jogo.

## Escolher e preparar o backend

O cliente ainda não escolheu uma API. É possível avaliar fornecedor ou executor
próprio com emulador conforme [ROOM_AUTOMATION.md](ROOM_AUTOMATION.md). Na alternativa
própria, definir máquina/emulador, executar `npm run emulator:doctor` e observar
as telas do jogo antes de implementar o driver. O diagnóstico não cria salas.
O gateway precisa implementar o contrato e comprovar as operações no jogo.

Para a opção de fornecedor:

Solicitar nome/link da documentação, região e conta de homologação com cota.
Confirmar com exemplos documentados: autenticação, catálogo, criação, consulta por
ID, recuperação por referência, edição, cancelamento e encerramento. A documentação
deve explicar idempotência e estados de cada operação. Uma referência comercial
como Storm Salas não confirma o protocolo de sua API.

Se o fornecedor não falar [room-management-v2](ROOM_API_V2.md), adaptar o cliente
ou usar gateway compatível antes de configurar essa versão como contrato válido.
Operação obrigatória não suportada precisa de solução com o fornecedor.

Configurar no cofre da hospedagem, sem enviar valores no chat:

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`.
- `ROOMS_PROVIDER=api`, `ROOMS_API_CONTRACT=room-management-v2` após confirmação.
- `ROOMS_API_URL`, `ROOMS_API_KEY` e esquema de autenticação documentado.

Separar servidor Discord de teste, cargos de gerente/operador/visualizador, canais
restritos e uma conta de jogador para conferir as salas no Free Fire.

## Conferir conexões

```bash
npm run build
npm run doctor
npm run verify:connections
```

`doctor` é local. `verify:connections` usa somente GET: verifica que o token pertence
à aplicação indicada, que o servidor está acessível, que `/sala` e `/salas` e suas
opções correspondem ao código e que o catálogo declara as seis capacidades exigidas.
Não altera comandos, não cria salas, não abre o banco e não imprime credenciais.

Saída JSON: `checks` descreve cada resultado; `connectionsVerified` só será `true`
se todos passarem. Pendência ou falha resulta em código de saída 1.
`homologated` permanece `false`: a ferramenta não observa o jogo nem certifica as
operações apenas com o catálogo. Um fornecedor indisponível não será substituído
silenciosamente pelo simulador.

Se os comandos estiverem ausentes/desatualizados, conferir aplicação/servidor antes
de executar `npm run register`. Esse registro substitui os comandos dessa aplicação
no servidor configurado. A verificação por GET não registra nada automaticamente.
Em Docker, usar `node dist/src/rooms/verify.js` dentro da imagem compilada.

## Executar o aceite

Registrar data, versão entregue, responsável, referência interna da sala e resultado
de cada caso. Guardar evidência em local restrito, removendo senha, tokens e chaves.

| Caso | Critério para passar |
| --- | --- |
| Configuração | Canais/cargos/limites salvos; painel disponível após reinício |
| Criação | Modo/mapa/capacidade/extras escolhidos; uma única criação confirmada |
| Entrada no jogo | ID/senha permitem entrar e opções no Free Fire coincidem |
| Consulta | Estado e data refletem a sala real; mesmo embed é atualizado |
| Edição | Alteração permitida aparece no jogo e no embed; imutável é recusada |
| Cancelamento | Fornecedor confirma cancelamento remoto; histórico preservado |
| Encerramento | Fornecedor confirma encerramento remoto; histórico preservado |
| Permissões | Operador só gerencia as próprias salas; visualizador não recebe senha |
| Revogação | Cargo removido e botões antigos não dão acesso a dados privados |
| Reinício | Configuração/salas/histórico mantidos; nenhuma sala é recriada |
| Mensagens | Mensagem excluída é recuperada; mudança de canal remove dados antigos |
| Recuperação de entrega | Gerente diagnostica falha, corrige permissões e reprocessa sem criar outra sala |
| Saúde e parada | Healthcheck reflete Gateway/banco; parada não perde pedidos persistidos |
| Falhas | Indisponibilidade/timeout/429 não duplicam escrita nem anunciam sucesso |
| Backup | Cópia validada abre isoladamente e contém os registros esperados |

Falhas provocadas de rede devem usar gateway/ambiente de teste controlado com
cota combinada. Não manipular salas de jogadores em uso para simular erros.

O aceite termina quando os casos obrigatórios passam com o fornecedor real e a
entrada no jogo é conferida. Anotar limitações e pendências sem marcá-las como
aprovadas. Atualizar [STATUS.md](../STATUS.md) com a evidência obtida.
