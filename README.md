# Bot de Salas Free Fire para Discord

Edição exclusiva de criação e gerenciamento de salas, com painel no Discord,
catálogo configurável e histórico persistente. Referência funcional: Storm Salas.

## Implementado

- Painel com menus, formulário, prévia e confirmação de criação.
- Modo, mapa, capacidade e opções adicionais validados pelo catálogo.
- Criar, consultar, editar, cancelar e encerrar salas sem partidas ou pagamentos.
- Canais/cargos por servidor, limites e histórico após reinício.
- Embeds protegidos, recuperação de mensagens e pedidos incertos sem duplicações.
- Provedor simulado persistente e cliente HTTP de gerenciamento completo.
- Verificação de conexão com Discord/API sem criar salas nem alterar comandos.
- Diagnóstico privado, recuperação auditada de entregas e healthcheck da hospedagem.

## Executar localmente

```bash
npm ci
npm run verify:local
```

O demo não acessa o jogo. Para o Discord, configure as variáveis de `.env.example`,
execute `npm run build`, `npm run register` e `npm start`.
O registro substitui os comandos desta aplicação no servidor configurado.

## Situação

80% do roteiro de implementação: 8/10 marcos locais em [STATUS.md](STATUS.md).
149 testes de salas e 302 testes totais passaram. Faltam backend real/credenciais e
homologação real. O contrato HTTP precisa ser validado/adaptado à API escolhida.

[Guia do cliente](GUIA_CLIENTE.md) · [Plano](PLANO.md) · [Desenvolvimento](DESENVOLVIMENTO.md) ·
[Contrato HTTP](docs/ROOM_API_V2.md) · [Implantação](docs/DEPLOY.md) · [Homologação](docs/HOMOLOGACAO.md)

Pacote exclusivo para o cliente: `npm run package:rooms` ([entrega](docs/ENTREGA.md)).
API ou automação própria com emulador: [alternativas e preparação](docs/ROOM_AUTOMATION.md).
Recomendação para custo e prazo, com PIX avulso: [viabilidade](docs/VIABILIDADE.md).
