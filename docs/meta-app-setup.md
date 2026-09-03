# Configuração do app na plataforma Meta

Este é o manual canônico em pt-BR para configurar o MyChat com Instagram
Login. Ele leva uma instalação do domínio e HTTPS até a primeira prova real de
evento. Os rótulos das capturas estão em inglês, como aparecem no painel da
Meta, e as imagens são anonimizadas.

Use este roteiro uma vez para a sua instalação de produção. Ela precisa de app
Meta, conta profissional, callback HTTPS, segredos, arquivo `.env` e dados
persistidos próprios.

## Antes de começar: domínio, HTTPS e instalação

Prepare estes itens antes de criar ou preencher qualquer credencial Meta:

- uma VM com domínio próprio, DNS apontado e HTTPS válido;
- uma URL pública HTTPS para a política de privacidade;
- uma conta profissional do Instagram (Business ou Creator), pública;
- uma instalação do MyChat separada para este ambiente.

A ordem deste guia é deliberada: domínio e HTTPS vêm antes das credenciais;
as credenciais são conferidas no MyChat antes de cadastrar callback ou webhook;
o teste de `comments` vem antes da assinatura da conta; a publicação fica no
fim da configuração.

## 1. Criar o app e escolher o caso de uso

Em `developers.facebook.com/apps`, use **Create App**.

![Create App](images/meta-app-setup/create-app.png)

Informe um nome e um e-mail de contato. Em **Use cases**, filtre por **Business
Messaging** e escolha **Manage messages and content on Instagram**.

![Manage messages and content on Instagram](images/meta-app-setup/customize-instagram-use-case.png)

Na escolha do portfólio, selecione **I don't want to connect a business
portfolio yet**. O caminho Instagram Login para a própria conta não precisa de
portfólio empresarial.

![I don't want to connect a business portfolio yet](images/meta-app-setup/business-portfolio-later.png)

Avance quando a tela indicar que não há requisitos pendentes e confira o
resumo antes de criar o app.

![No requirements identified](images/meta-app-setup/requirements-next.png)

![Review and create the app](images/meta-app-setup/overview-create-app.png)

A Meta pode pedir sua senha para confirmar a criação.

## 2. Adicionar as permissões do Instagram Login

Abra o caso de uso criado, selecione **Customize** e entre em **Instagram
Login API setup**. No primeiro passo, use **Add all required permissions**.

![Add all required permissions](images/meta-app-setup/add-required-permissions.png)

Para o caminho Instagram Login, confirme estas permissões:

- `instagram_business_basic`;
- `instagram_business_manage_comments`;
- `instagram_business_manage_messages`.

**Standard Access**, exibido em algumas telas como **Ready for testing**, é
suficiente para a instalação operar a própria conta. Advanced Access e App
Review são necessários para operar contas de terceiros, não para o caso de uma
instância que opera a própria conta.

### Caminho opcional de usuário de sistema

Se você já possui um portfólio empresarial e precisa operar contas de terceiros,
pode escolher o caminho de usuário de sistema. Ele usa a Facebook Graph API,
`instagram_manage_comments` e um token sem expiração, além dos requisitos do
portfólio. Instagram Login usa `graph.instagram.com`, as permissões
`instagram_business_*` e o token renovável. Escolha um caminho por instalação,
registre a escolha no ambiente e não misture tokens ou IDs entre os caminhos.

## 3. Associar e aceitar a conta testadora

No painel do app, abra **App roles** e depois **Roles**. Abra a área de contas
testadoras do Instagram.

![Open app roles](images/meta-app-setup/open-testers-role.png)

![Open Instagram Testers](images/meta-app-setup/open-instagram-testers-tab.png)

Use **Add People**.

![Add people](images/meta-app-setup/add-tester.png)

Selecione **Instagram Tester** nas funções adicionais.

![Select Instagram Tester](images/meta-app-setup/select-instagram-tester.png)

Digite o nome de usuário da conta profissional que ficará ligada a esta
instalação.

![Enter the Instagram username](images/meta-app-setup/enter-instagram-username.png)

Confirme que o convite está **Pending**.

![Instagram tester invitation pending](images/meta-app-setup/instagram-tester-pending.png)

O convite não é aceito no painel de desenvolvedores. Já logado na conta
convidada, abra `https://www.instagram.com/accounts/manage_access/`, ou use no
aplicativo Instagram **Perfil → menu → Configurações e privacidade → Apps e
sites → Convites de testador**.

![Accept the Instagram tester invitation](images/meta-app-setup/accept-instagram-tester-invite.png)

Volte ao painel e confirme que a conta aparece como testadora ativa.

![Instagram tester active](images/meta-app-setup/instagram-tester-active.png)

## 4. Gerar o token e guardar as credenciais

Só faça este passo depois que o domínio e o HTTPS do ambiente estiverem
prontos. No **Instagram Login API setup**, use **Generate token** na linha da
conta que aceitou o convite.

![Generate Instagram token](images/meta-app-setup/generate-instagram-token.png)

Entre na mesma conta Instagram.

![Instagram token login](images/meta-app-setup/instagram-token-login.png)

Conceda as permissões solicitadas.

![Authorize Instagram permissions](images/meta-app-setup/authorize-instagram-permissions.png)

Guarde o token uma única vez em um gestor de senhas. Ele nunca deve aparecer
no repositório, em uma issue, no chat, em uma captura ou em histórico de shell.

![Copy the generated token](images/meta-app-setup/copy-generated-token.png)

No mesmo **Instagram Login API setup**, revele o **Instagram App Secret**. Ele
é o segredo que assina os webhooks desta integração, e não o **App Secret**
geral de **App settings → Basic**.

![Reveal the Instagram App Secret](images/meta-app-setup/reveal-instagram-app-secret.png)

Depois de domínio e HTTPS estarem preparados, coloque somente marcadores ou os
valores privados do seu ambiente no `.env`:

```dotenv
META_APP_SECRET=<segredo-do-app-instagram>
WEBHOOK_VERIFY_TOKEN=<token-aleatorio-de-verificacao>
META_ACCESS_TOKEN=<token-gerado-pela-meta>
INSTAGRAM_ACCOUNT_ID=<id-da-conta-profissional>
```

Na tela da conta, copie o ID da conta profissional para
`INSTAGRAM_ACCOUNT_ID`. Ele não é o App ID que aparece na URL do painel.

![Instagram account ID in the environment](images/meta-app-setup/instagram-account-id-env.png)

Para confirmar o ID sem colocar o token literal em uma linha de comando, use o
valor já guardado no `.env`:

```bash
TOKEN=$(grep '^META_ACCESS_TOKEN=' .env | cut -d= -f2-)
curl -s "https://graph.instagram.com/v23.0/me?fields=id,user_id,username,account_type&access_token=$TOKEN"
```

Use `user_id` como `INSTAGRAM_ACCOUNT_ID`, não `id`. Confirme também que
`account_type` é `BUSINESS` ou `MEDIA_CREATOR`.

Reinicie o MyChat depois de alterar o `.env`, pois as variáveis são lidas na
inicialização. O túnel não precisa ser reiniciado.

## 5. Validar a conta no MyChat antes do webhook

Esta é uma barreira obrigatória. Antes de cadastrar callback URL, verify token
ou qualquer assinatura de webhook:

1. inicie ou reinicie o MyChat com este `.env`;
2. defina a senha local do painel, se ainda não existir;
3. abra **Publicações** e use **Atualizar a lista**;
4. confirme que as publicações da conta conectada são carregadas;
5. confirme que o menu lateral mostra o usuário e a foto da mesma conta.

Se publicações, nome ou foto não corresponderem à conta esperada, pare aqui.
Revise `META_ACCESS_TOKEN` e `INSTAGRAM_ACCOUNT_ID`. Não exponha um endpoint
para a Meta enquanto a aplicação não provar que está ligada à conta correta.

Confira também:

```bash
npm run cli status
```

O status deve mostrar a autenticação configurada e a expiração do token.

## 6. Cadastrar e verificar o callback HTTPS

Somente depois da validação do MyChat, vá ao passo de webhook do **Instagram
Login API setup**. O processo precisa estar no ar e acessível pelo domínio
HTTPS antes de clicar em **Verify and save**.

![Configure the webhook callback](images/meta-app-setup/configure-webhook-callback.png)

Use a URL HTTPS que termina em `/webhook` e informe exatamente o mesmo valor de
`WEBHOOK_VERIFY_TOKEN` configurado no `.env`. Confira antes com um marcador
substituído localmente:

```bash
curl "https://SEU-DOMINIO/webhook?hub.mode=subscribe&hub.verify_token=SEU-TOKEN&hub.challenge=123"
```

A resposta precisa ser exatamente `123`. Um `403` indica tokens diferentes;
`502`, timeout ou erro de TLS indica que o domínio não consegue alcançar o
MyChat. A rota `/webhook` deve continuar pública, sem senha do painel ou
Cloudflare Access na frente dela.

Depois de aceitar, a Meta mostra o ícone verde e a lista **Webhook fields**.

![Webhook endpoint accepted](images/meta-app-setup/webhook-endpoint-accepted.png)

## 7. Testar comentários antes de assinar a conta

Na lista **Webhook fields**, use **Test** uma vez ao lado de `comments` e
confirme que o MyChat registra o evento. Esse é o teste de conectividade do
webhook. O teste `messages` do painel não simula uma DM recebida que o MyChat
possa exibir, então não o use como teste de mensagem direta.

## 8. Ativar a assinatura dos eventos

Na lista de campos do app, confirme `comments` e `messages`. Depois, na linha
da conta Instagram, ative **Webhook subscription**.

![Enable webhook subscription](images/meta-app-setup/enable-webhook-subscription.png)

São duas assinaturas diferentes:

- a assinatura do app habilita os campos que o aplicativo pode receber;
- a assinatura da conta define os campos que aquela conta realmente entrega.

Confira a assinatura da conta usando o token privado do ambiente:

```bash
TOKEN=$(grep '^META_ACCESS_TOKEN=' .env | cut -d= -f2-)
curl -s "https://graph.instagram.com/v23.0/me/subscribed_apps?access_token=$TOKEN"
```

`subscribed_fields` precisa conter `comments` e `messages`. Se `comments`
estiver ausente, corrija a assinatura da conta e consulte novamente:

```bash
curl -s -X POST "https://graph.instagram.com/v23.0/me/subscribed_apps?subscribed_fields=comments,messages&access_token=$TOKEN"
```

`comments` dispara o caso âncora e `messages` permite que o MyChat receba a
resposta do contato. Sem os dois, a automação pode parecer parcialmente
configurada e ainda assim não completar o fluxo.

## 9. Publicar o app em modo Live

Abra **Publish**. Se a Meta indicar configurações pendentes, use o link para
voltar a **App settings → Basic**, preencha uma URL pública de política de
privacidade e escolha a categoria **Messaging**.

![Open privacy policy requirements](images/meta-app-setup/publish-add-privacy-policy.png)

![Set the privacy policy URL](images/meta-app-setup/set-privacy-policy-url.png)

Quando todos os requisitos estiverem concluídos, use **Publish** para colocar
o app em modo **Live**.

![Publish the app](images/meta-app-setup/publish-app.png)

![App published successfully](images/meta-app-setup/app-published-success.png)

O modo de desenvolvimento não prova entrega normal de eventos. A publicação
é necessária antes da prova real.

## 10. Fazer a prova real da automação

Crie ou ative uma automação pequena no MyChat e faça um comentário de teste em
uma publicação da conta profissional configurada. Se a automação enviar uma
resposta privada, confira a conversa no perfil que fez o comentário.

Registre os três fatos:

1. a Meta enviou o evento ao callback HTTPS;
2. o MyChat registrou e executou a automação;
3. a ação configurada foi concluída conforme esperado.

Token configurado, callback verde ou teste manual do painel, isoladamente, não
são prova ponta a ponta. Se o teste falhar, confira o diagnóstico abaixo sem
alterar as credenciais ou a URL pública que acabaram de ser validadas.

## Diagnóstico de erros comuns

| Sintoma | Causa provável e recuperação |
| --- | --- |
| **Verify and save** falha | Inicie o MyChat, confirme HTTPS público e confira o `WEBHOOK_VERIFY_TOKEN` nos dois lados. |
| Toda assinatura é inválida | Use o **Instagram App Secret** do Instagram Login, não o segredo geral do app, e reinicie o MyChat. |
| Não aparece **Generate token** | Aceite o convite de **Instagram Tester** dentro do Instagram e confirme conta pública e profissional. |
| Publicações não carregam | Confira `META_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID` e `account_type` antes do webhook. |
| Mensagens chegam, comentários não | Confira `comments` na assinatura do app e em `subscribed_fields` da conta. |
| Token é válido, mas o envio falha | Use `user_id` como `INSTAGRAM_ACCOUNT_ID`, não o `id` com escopo do app. |
| Nada chega após um comentário real | Confirme modo Live e bypass público de `/webhook`. |

## Sobre App Review

Advanced Access e App Review são voltados a aplicações que operam contas de
terceiros. Uma instalação que opera somente a própria conta pode usar Standard
Access no caminho Instagram Login, sem CNPJ, portfólio empresarial ou análise
do app, desde que respeite os requisitos mostrados no painel.

Isso não torna os caminhos intercambiáveis. O usuário de sistema exige
portfólio empresarial, usa outro host, outra permissão de comentários e outro
modelo de token. Registre um único caminho por ambiente.
