# Runtime com Docker Compose

Este arquivo instala uma imagem publicada. Nao e necessario clonar este
repositorio, executar `docker build` ou manter ferramentas de compilacao na
maquina que vai hospedar o MyChat.

## Iniciar

1. Baixe `docker-compose.yml` e `.env.example` de uma versao publicada em um
   diretorio novo. Copie o exemplo para `.env` e preencha pelo menos
   `META_APP_SECRET` e `WEBHOOK_VERIFY_TOKEN`.
2. Para uma versao imutavel, substitua `latest` em `docker-compose.yml` pela
   tag da versao que deseja executar antes de iniciar.
3. Execute `docker compose up -d` nesse diretorio. A composicao baixa a imagem
   publicada e a deixa acessivel somente em `127.0.0.1:3000`; coloque um proxy
   TLS na frente dela antes de expor o servico na internet.

O `.env` fica fora da imagem e nao deve ser enviado para um repositorio. A
composicao tambem cria o volume nomeado `mychat-data`: nele ficam o SQLite,
os anexos e as miniaturas. Portanto, `docker compose restart`, `down` seguido
de `up -d` e uma atualizacao de imagem preservam as automacoes e os dados.
Nao use `docker compose down -v` em uma instalacao que deseja preservar,
porque a opcao `-v` remove o volume de dados.

## Colima no macOS

Colima e usado somente quando for preciso baixar, construir ou verificar uma
imagem. Ele nao precisa ficar aberto para desenvolvimento local do MyChat.

```sh
colima start --cpus 2 --memory 4
docker compose up -d
# quando nao houver mais operacao de containers:
colima stop
```

Parar o Colima interrompe os containers, mas nao remove `mychat-data`.
Na proxima inicializacao, execute `colima start` e `docker compose up -d`
novamente para retomar o mesmo estado persistido.
