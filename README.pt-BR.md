# MyChat

O MyChat é um serviço de automação auto-hospedado para uma conta Instagram. A
aplicação, os dados SQLite e os anexos ficam no seu host. Uma instalação nova
pode ser conhecida sem credenciais Meta, mas um rascunho salvo localmente não
prova que a Meta recebeu um evento nem que uma mensagem foi entregue.

[Read in English](README.md).

## Instalação

Use Ubuntu LTS 22.04 ou 24.04, em `amd64` ou `arm64`. Mantenha acesso SSH
recuperável e espaço para o volume persistente `mychat-data`.

1. Baixe o `docker-compose.yml` e o `.env.example` da versão publicada em um
   diretório novo e privado. Copie `.env.example` para `.env`; nunca versione
   nem compartilhe o `.env` resultante.
2. Gere no host valores únicos para `META_APP_SECRET` e
   `WEBHOOK_VERIFY_TOKEN`, e guarde-os somente no `.env`. Não cole token no
   histórico do shell, issue, chat ou captura de tela.
3. Inicie a imagem publicada com `docker compose up -d` e confirme com
   `docker compose ps --status running`.
4. Preserve `mychat-data`. Não use `docker compose down -v` a menos que apagar
   os dados da instância seja intencional.

Para o plano local, guiado e repetível, consulte o
[guia de instalação](docs/installing.md). Uma reexecução segura preserva o
`.env` e o volume existentes, e pede confirmação antes de trocar um segredo.

## Primeira automação

Escolha um dos caminhos conscientemente:

- **Local, sem Meta:** abra o painel local, crie uma automação simples e
  salve-a como rascunho. O resultado esperado é `rascunho local`; ele prova só
  a persistência local e não envia nada à Meta.
- **Integração Meta real:** configure a Meta antes e use uma segunda conta de
  teste para gerar o evento. Registre três evidências: recebimento do evento,
  execução da automação e resultado recebido pela segunda conta. Essa
  homologação externa está prevista para a Fase 4e.

O roteiro detalhado está em [docs/first-use.md](docs/first-use.md).

## Autenticação Meta

O MyChat possui dois caminhos distintos de autenticação. Comece por
**Instagram Login**, salvo se você já opera um portfólio empresarial Meta e
precisa especificamente do caminho opcional de **usuário de sistema**. Eles
não são intercambiáveis: host da API, permissão de comentários e duração do
token são diferentes. Depois da escolha, a aplicação usa um único contrato
`PlatformAccount`, portanto a lógica de fluxos e entregas não escolhe o caminho
pela credencial.

Leia o [guia de autenticação](docs/authentication.md) antes de informar uma
credencial. Mantenha `/webhook` público: uma camada externa de autenticação
precisa ignorá-lo explicitamente, ou as entregas da Meta param em silêncio.

Para o roteiro de Instagram Login, veja o
[guia de configuração da Meta](docs/meta-app-setup.md).
