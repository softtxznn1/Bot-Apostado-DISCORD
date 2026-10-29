# Caminho recomendado para concluir o projeto

Pesquisa em 26/10/2026. Prioridades: custo baixo, pouca configuração e entrega rápida.
O cliente confirmou **PIX avulso**, sem vender salas/créditos, e ainda não definiu PC/VPS.

## Decisão recomendada

**API comercial de salas + bot em hospedagem Node/Docker + Mercado Pago para PIX avulso.**
Para priorizar facilidade/prazo, Railway é a primeira opção operacional; Fly.io é
a alternativa com menor base de hospedagem documentada nesta comparação. Isso é
uma recomendação de arquitetura: nenhum fornecedor de salas foi homologado.

Uma API compatível evita desenvolver/manter a automação das telas do jogo, instalar
Android e manter uma máquina gráfica ligada. O bot já possui interface de provedor,
cliente HTTP, histórico e recuperação; ainda será preciso adaptar o contrato real.
Emulador fica como alternativa se as APIs não atenderem ou se o custo por volume
justificar desenvolver e manter um executor próprio. Esse driver ainda não existe.

## Hospedagem: valores encontrados em documentação oficial

| Opção | Base documentada | Avaliação para este projeto |
| --- | --- | --- |
| Railway Hobby | Mínimo de US$5/mês, com US$5 de consumo incluído | Painel e integração GitHub/Docker; menor esforço operacional proposto |
| Fly.io | US$3,84 por 30 dias: 512 MB por US$3,69 + volume de 1 GB por US$0,15 | Menor base documentada; exige configuração inicial |
| Discloud/SquareCloud | Preço atual não confirmado nesta consulta | Confirmar preço, Node 24, persistência e processo 24/7 antes de comparar |
| PC/VPS para emulador | Sem cotação validada | Adiciona máquina, eventual licença, energia, jogo/conta e desenvolvimento do executor |

Fly: valores para `iad`/`ewr`, 30 dias contínuos. Um mês de 31 dias custa um pouco
mais. 512 MB é ponto inicial proposto, sem benchmark de produção deste bot.
O volume é necessário para SQLite e não possui replicação automática.

Railway: o mínimo não é somado novamente a todo consumo. Até US$5 de recursos,
a cobrança-base é US$5; acima disso, paga-se o consumo total. CPU/RAM/disco/rede
podem elevar a fatura. A documentação direciona Pro a aplicações/equipes de produção;
confirmar os recursos e o enquadramento da conta do cliente antes de contratar.

As bases acima **não incluem API de salas, tarifas PIX, impostos/câmbio e custos
adicionais de tráfego/recursos**. Não foi feita conversão para reais nem orçamento
fechado. Os sites comerciais foram bloqueados pelo túnel; as tabelas vieram dos
repositórios oficiais de documentação, fixados nas fontes abaixo.

O bot requer Node 24, processo contínuo com Gateway Discord e disco persistente.
Uma instância evita duplicar o bot e atende ao SQLite atual. Antes do deploy,
ajustar/conferir propriedade do volume para `USER node`; o volume Railway é montado
como root. Não houve implantação/homologação nessas plataformas nesta pesquisa.

## APIs de salas: candidatos para qualificar

| Candidato | Evidência disponível | O que ainda falta |
| --- | --- | --- |
| SalasBot FF | README de cliente terceiro descreve criação, cinco modos e consulta de jogadores; base `salas-bot.freefireapi.online` | Documentação do fornecedor, preço/cota, edição, cancelamento/encerramento e recuperação |
| SalasFF | Cliente terceiro contém criar, consultar, iniciar, checar e expulsar; base `salasff.com.br` | Contrato/preço atuais, demais operações e criação real |
| API Nix | README de cliente terceiro descreve ID/senha, início e liberação de sessão; usa 4v4 e três templates; base `salas.nixbot.vip` | Cobertura de mapas/modos exigidos, preço, edição e recuperação; semântica de cancelar/encerrar |

Esses nomes são leads para orçamento/teste, sem recomendação comercial homologada.
Não foi possível confirmar qual tem menor preço, disponibilidade ou plano de teste.
SalasBot/Nix tiveram conexão recusada pelo proxy com 403; SalasFF expirou por timeout.
Isso não comprova indisponibilidade dos serviços. Não usar preço configurável de um
bot de terceiro como se fosse cotação comercial da API.

Antes de escolher, obter demonstração de sala real e conferir: criação e dados de
entrada, consulta/estado, edição suportada, cancelamento, encerramento e recuperação
por referência após resposta perdida. Pedir preço por uso, mínimo/mensalidade,
validade de créditos, cotas, modos/mapas e tratamento de falhas. API que só cria
salas não fecha os requisitos atuais. Não há promessa comprovada de salas ilimitadas.

## PIX avulso

Recomendação inicial: Mercado Pago com consulta periódica da cobrança. O adaptador
existente usa access token, sem certificado mTLS; polling dispensa um endpoint
público de webhook nessa primeira etapa. Webhook pode ser acrescentado depois.
Efí é alternativa se a conta/certificado já estiverem preparados ou as condições
comerciais compensarem a configuração adicional. Tarifas atuais não foram confirmadas.
IMAP permanece apenas auxiliar para notificações, sem substituir consulta bancária.

O módulo anterior depende de partidas. Para PIX avulso, implementar cobrança
persistente independente com servidor/usuário, valor, referência, conta recebedora,
estado e QR/copia e cola; emissão/consulta privadas e recuperação sem duplicação.
Pagamento aprovado **não cria sala, não libera crédito e não participa de aposta**.
Esse módulo avulso ainda não foi implementado; confirmar o escopo não o ativa.

## Ordem para terminar com menor retrabalho

1. Qualificar API de salas e comprovar os comandos exigidos com uma sala real.
2. Implementar o adaptador do contrato escolhido; testar incerteza/idempotência.
3. Desacoplar a cobrança PIX avulsa de partidas, reutilizando o adaptador Mercado Pago.
4. Preparar hospedagem, volume, tokens/IDs e registrar os comandos no servidor correto.
5. Homologar salas e PIX separadamente; testar reinício, permissões e backup.

O prazo depende do acesso/ativação da API e da conta de pagamentos, não apenas de
código. Não há prazo garantido enquanto o backend real não for comprovado.
O emulador exige [prova de conceito própria](ROOM_AUTOMATION.md) se essa rota falhar.

## Fontes

- [Fly.io: preços e exemplo oficial de bot Discord 24/7](https://github.com/superfly/docs/blob/bb565d01e7a745574cc96f37e1297a7bac19552d/about/pricing.mdx#L15).
- [Fly.io: persistência e limites dos volumes](https://github.com/superfly/docs/blob/bb565d01e7a745574cc96f37e1297a7bac19552d/volumes/overview.mdx#L35).
- [Railway: planos e consumo incluído](https://github.com/railwayapp/docs/blob/4bc46bc0ba1b27d50c5ef0393132753982b31112/content/docs/pricing/plans.md#L21).
- [Railway: propriedade dos volumes](https://github.com/railwayapp/docs/blob/4bc46bc0ba1b27d50c5ef0393132753982b31112/content/docs/volumes.md#L117).
- [SalasBot FF: README de terceiro](https://github.com/171rodrigues0340-beep/bot-vendas-salas/blob/a192469521ebfaad92a69376d9d65477bbcbabe7/README.md#L3).
- [SalasFF: cliente de terceiro](https://github.com/Cajuz/bot_telegram-loop_salas/blob/7f843e42c1f3fa1665df655423ad6c3f9d976a22/app/api_clients/freefire_client.py).
- [API Nix: README de terceiro](https://github.com/migueljosefeli7/acebot/blob/225f8e9ab4ec4fe127bc9bf6c901076b750b482d/README.md#L186).
- [SDK oficial Mercado Pago](https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/README.md).
- [SDK oficial Efí](https://github.com/efipay/sdk-node-apis-efi/blob/d742ee94b76097383c42792494351a68568e23a9/README.md).

Nenhuma conta foi criada/contratada, vendedor contatado ou chamada autenticada
executada. Fontes de SDK confirmam preparação técnica, sem certificar tarifas,
elegibilidade ou funcionamento real das contas do cliente.
