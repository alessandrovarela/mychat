# Meta authentication / Autenticação Meta

MyChat supports two different Meta authentication paths behind the same
`PlatformAccount` contract. Choose one for an installation. The choice changes
the API host, comment permission and token model; it is not merely two ways to
obtain the same token.

O MyChat oferece dois caminhos diferentes de autenticação Meta sob o mesmo
contrato `PlatformAccount`. Escolha um para a instalação. A escolha muda o host
da API, a permissão de comentários e o modelo do token; não são só duas formas
de obter o mesmo token.

## Choose a path / Escolha um caminho

| Path / Caminho | Use when / Use quando | API host | Comment permission / Permissão de comentários | Token model / Modelo do token |
| --- | --- | --- | --- | --- |
| Instagram Login | You operate one account and do not have, or do not need, a Meta business portfolio. / Você opera uma conta e não tem, ou não precisa de, portfólio empresarial Meta. | `graph.instagram.com` | `instagram_business_manage_comments` | Expires, normally after 60 days; MyChat renews it before expiry and alerts on failure. / Expira, normalmente após 60 dias; o MyChat o renova antes do vencimento e alerta em caso de falha. |
| System user / Usuário de sistema | You already have a Meta business portfolio and its required assets and administration. / Você já tem um portfólio empresarial Meta e os ativos e a administração exigidos. | `graph.facebook.com` | `instagram_manage_comments` | Does not expire, but is still checked for revocation, removal or lost permission. / Não expira, mas ainda é verificado contra revogação, remoção ou perda de permissão. |

Instagram Login is the low-barrier default. It does not require a Facebook
Page or business portfolio. A system user cannot exist independently of a
business portfolio, so do not choose it simply to avoid renewal. A
non-expiring token can still be revoked, have its permissions removed, or lose
access when the system user is removed from the portfolio.

Instagram Login é o padrão de menor barreira. Ele não exige Página do Facebook
nem portfólio empresarial. Um usuário de sistema não existe fora de um
portfólio empresarial, portanto não o escolha apenas para evitar renovação. Um
token sem expiração ainda pode ser revogado, perder permissões ou acesso quando
o usuário de sistema é removido do portfólio.

## Safe configuration / Configuração segura

1. Start with the matching path's Meta setup. For Instagram Login, follow
   [the setup guide](meta-app-setup.md), including its permissions and account
   ID checks. For a system user, confirm the portfolio, system-user role,
   assets and permissions in Meta before choosing that path.
2. Put secrets only in the installation's private `.env` or credential store.
   Never put an access token, app secret, verify token, or real account ID in
   Git, a support request, a browser address, shell history, screenshot or
   test fixture. Use placeholders such as `<masked-token>` in examples.
3. Keep the application path-specific only at the account adapter. The rest of
   MyChat receives `PlatformAccount`, which supplies the selected host, token,
   expiry and health. Do not make flow, queue or sender code infer a path from
   a token value.
4. Check credential health on either path. Renewal is required only for the
   expiring Instagram Login path; on the system-user path renewal is inert,
   while health checks remain required.

1. Comece pela configuração Meta correspondente. Para Instagram Login, siga o
   [guia de configuração](meta-app-setup.md), inclusive permissões e checagem
   do ID da conta. Para usuário de sistema, confirme antes no painel Meta o
   portfólio, a função do usuário de sistema, os ativos e as permissões.
2. Guarde segredos somente no `.env` privado da instalação ou no repositório
   de credenciais. Nunca coloque token de acesso, segredo do app, token de
   verificação ou ID real de conta no Git, pedido de suporte, endereço do
   navegador, histórico do shell, captura de tela ou fixture de teste. Use
   marcadores como `<masked-token>` nos exemplos.
3. Mantenha a especificidade do caminho no adaptador de conta. O restante do
   MyChat recebe `PlatformAccount`, que fornece host, token, expiração e saúde
   escolhidos. Não faça fluxo, fila ou remetente deduzir o caminho pelo token.
4. Verifique a saúde da credencial nos dois caminhos. Renovação é exigida só no
   Instagram Login que expira; no usuário de sistema ela é inócua, mas a
   checagem de saúde continua obrigatória.

## Webhook boundary / Limite do webhook

`/webhook` must remain public for both paths. If a reverse proxy, gateway or
Meta access layer protects `/dashboard` or `/api/*`, configure and verify an
explicit `/webhook` bypass. Never point a production callback to a local test
process or tunnel. Production and test callbacks each need their own HTTPS
address and their own secrets.

`/webhook` deve permanecer público nos dois caminhos. Se proxy reverso,
gateway ou camada de acesso Meta proteger `/dashboard` ou `/api/*`, configure
e verifique um bypass explícito para `/webhook`. Nunca aponte callback de
produção para processo ou túnel local de teste. Callbacks de produção e teste
precisam cada um do seu endereço HTTPS e de seus próprios segredos.

The complete Meta setup tutorial is currently written for Instagram Login:
[English/Portuguese setup guide](meta-app-setup.md). The real external
verification with a separate account remains Phase 4e.

O tutorial completo de configuração Meta disponível hoje é o de Instagram
Login: [guia de configuração](meta-app-setup.md). A homologação externa real
com uma segunda conta continua na Fase 4e.
