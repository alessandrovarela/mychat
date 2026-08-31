# Operação do MyChat

Este é um runbook de preparação para uma instância publicada. Não execute atos
externos durante esta fase: contratar domínio ou VM, abrir conta R2, criar bucket,
alterar DNS, emitir certificado ou homologar com a Meta pertence à Fase 4e.
Substitua todos os valores entre `<...>` pelos valores da instância real somente
quando essa fase for autorizada.

## 1. Infraestrutura, domínio e HTTPS

**Pré-condições:** VM Ubuntu LTS escolhida, acesso SSH recuperável, domínio sob
seu controle, portas 80 e 443 liberadas e `.env` preservado fora do repositório.

**Procedimento futuro:** aponte o DNS de `<dominio>` para o IPv4 da VM, ponha um
proxy Caddy à frente de `127.0.0.1:3000` e configure `PUBLIC_ORIGIN=https://<dominio>`.
O [HTTPS automático do Caddy](https://caddyserver.com/docs/automatic-https)
requer nome de domínio e alcançabilidade pública para obter e renovar o
certificado. Defina `AUTH_TRUSTED_PROXY_HOPS=1`; nunca proteja `/webhook` com
uma camada que exija login.

**Resultado esperado:** `https://<dominio>` responde pela aplicação, o
certificado é válido e `https://<dominio>/webhook` continua acessível à Meta.

**Recuperação:** se o certificado não emitir, confirme DNS, portas e logs do
proxy; não desative TLS nem exponha a porta da aplicação publicamente. Se o
webhook receber autenticação, restaure o bypass de `/webhook` antes de testar
novamente. A execução e a homologação externas são adiadas para a Fase 4e.

## 2. R2 e backup contínuo

**Pré-condições:** bucket R2 privado já criado pelo operador, credenciais com
menor privilégio possível, endpoint S3, retenção definida e cópia de `.env`
guardada em cofre. Consulte [preços do R2](https://developers.cloudflare.com/r2/pricing/)
antes de criar dados ou automações de ciclo de vida.

**Procedimento futuro:** configure Litestream para replicar
`/var/lib/mychat/mychat.db` para um prefixo isolado do bucket, usando a
[configuração S3 do Litestream](https://litestream.io/guides/s3/). Mantenha
`assets/` e `thumbs/` separados das réplicas do banco e registre a retenção.

**Resultado esperado:** o estado do Litestream mostra réplica recente e o
volume `mychat-data` continua sendo a cópia de trabalho local.

**Recuperação:** se a réplica falhar, pare mudanças, confira endpoint,
credenciais, relógio, permissão e logs. Não apague o volume nem o bucket como
primeira resposta. A criação real de bucket e a prova de backup são da Fase 4e.

## 3. Restauração testável

**Pré-condições:** uma réplica conhecida, janela de manutenção, volume original
preservado e diretório de restauração vazio, fora do volume de produção.

**Procedimento futuro:** restaure primeiro para `<diretorio-de-teste>` com a
versão de Litestream documentada, abra o SQLite restaurado em cópia e verifique
as migrações e a integridade antes de trocar qualquer volume.

**Resultado esperado:** a cópia restaurada abre, contém dados no ponto esperado
e a instância em produção não foi alterada.

**Recuperação:** se a verificação falhar, descarte apenas a cópia de teste,
preserve volume e réplica originais e investigue logs/credenciais. Não substitua
`mychat-data` por uma restauração não verificada. A execução externa fica para a
Fase 4e.

## 4. Atualização e rollback

**Pré-condições:** tag de release conhecida, backup saudável, janela de
manutenção e versão atual registrada. O mecanismo automatizado de atualização
e rollback é entregue na Fase 4d; até lá este é apenas o contrato operacional.

**Procedimento futuro:** fixe uma tag em `docker-compose.yml`, obtenha a imagem,
aplique a atualização e acompanhe os logs e a saúde. Nunca use `latest` como
único registro da versão implantada.

**Resultado esperado:** versão e digest registrados, processo saudável e dados
preservados.

**Recuperação:** interrompa a progressão, mantenha o volume, volte à tag/digest
anterior somente pelo procedimento validado da Fase 4d e investigue antes de
repetir. Não faça downgrade às cegas após uma migração.

## 5. Diagnóstico

**Pré-condições:** acesso SSH, identificação da versão/digest, logs do proxy e
do serviço e nenhuma credencial colada no ticket ou terminal compartilhado.

**Procedimento futuro:** observe `docker compose ps`, `docker compose logs app`
e o comando `npm run cli -- status` dentro do contexto seguro da instância.
Classifique a falha como processo, volume, proxy/TLS, R2/Litestream ou
credencial Meta.

**Resultado esperado:** o diagnóstico identifica componente, evidência, ação
reversível e ponto de retomada.

**Recuperação:** faça uma mudança por vez, registre hora e versão e retorne ao
último estado saudável quando houver procedimento validado. Não rode comandos
destrutivos, recrie volume ou revele segredos. A coleta em VM real é adiada para
a Fase 4e.
