# Pacote de entrega da edição de salas

Na raiz do repositório, com Node.js 24 e GNU tar:

```bash
npm run package:rooms
```

O comando executa a validação local e produz um `.tar.gz` e seu SHA-256 em
`artifacts/`. O pacote é montado a partir de uma lista explícita de arquivos e
contém somente fontes, testes e documentação necessários à edição de salas.
Antes de publicar o arquivo, instala e valida essa árvore reduzida em diretório
temporário, usando o lockfile e os testes de salas. Falha de instalação/teste
impede a geração; o pacote antigo permanece preservado.
Arquivos `.env`, tokens, banco/backups, certificados, Git, caches, dependências e
builds anteriores não são incluídos. A configuração de exemplo não tem credenciais.

O `package.json` distribuído não possui entradas `legacy:*`. O Compose distribuído
possui somente o bot, sem o serviço de dashboard. Arquivos compartilhados de banco,
erros/configuração e outbox são preservados porque o bot de salas depende deles.
Credenciais preenchidas no arquivo de exemplo ou fontes simbólicas são recusadas.

O arquivo `RELEASE.json` identifica versão, escopo e pendências de validação real.
`MANIFEST.sha256` registra cada arquivo extraído, exceto o próprio manifesto.
Arquivos do arquivo tar têm ordem, data, permissões e proprietário normalizados.
O mesmo conteúdo gera o mesmo pacote; destinos já existentes são preservados.

## Conferir e instalar

```bash
sha256sum -c bot-salas-VERSAO-HASH.tar.gz.sha256
mkdir entrega-salas
tar -xzf bot-salas-VERSAO-HASH.tar.gz -C entrega-salas
cd entrega-salas
sha256sum -c MANIFEST.sha256
npm ci
npm run verify:local
```

Substituir o nome pelo arquivo gerado. O pacote contém os testes de salas; a base
legada e os respectivos testes permanecem no repositório original. Os comandos
acima não registram comandos no Discord nem criam salas reais.

Configure as variáveis seguras e siga `GUIA_CLIENTE.md`, `docs/DEPLOY.md` e
`docs/HOMOLOGACAO.md` e `docs/ROOM_AUTOMATION.md` antes da operação real. O backend
(fornecedor ou executor próprio) precisa ser validado. Empacotamento não certifica integração,
créditos/cotas, dados de entrada no jogo ou aceite do cliente.
