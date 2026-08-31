# Primeiro uso: rascunho local e prova real

Este roteiro tem dois caminhos deliberadamente diferentes. O primeiro permite
conhecer o MyChat sem uma conta ou aplicativo Meta. O segundo confirma uma
integração real, mas depende da configuração externa que será homologada na
Fase 4e.

## Caminho local, sem Meta

1. Entre no painel local e crie uma automação simples.
2. Salve-a sem conectar credenciais da Meta.
3. Confira o status **rascunho local**.

O resultado esperado é uma automação persistida como rascunho. Esse resultado
prova somente o salvamento local. Ele não prova que a Meta recebeu um evento,
que a automação foi executada por esse evento, nem que alguém recebeu uma
mensagem ou outro resultado.

É seguro repetir este caminho: salvar o rascunho não envia nada à Meta nem
inventa uma entrega bem-sucedida.

## Caminho real, depois da configuração Meta

Depois de configurar a Meta, o painel continua mostrando a automação como
**aguardando verificação externa**. Não a considere verificada por ter sido
salva localmente ou por possuir credenciais.

A prova real usa uma segunda conta de teste, distinta da conta operada, e
precisa registrar três evidências: o recebimento do evento, a execução da automação
e o resultado recebido pela segunda conta. Essa homologação externa
está explicitamente adiada para a Fase 4e, junto com a VM e o HTTPS reais.

Até a conclusão da 4e, trate a automação como rascunho. Caso a configuração
Meta falhe, corrija-a seguindo o guia de configuração e retome a prova real na
4e, sem transformar o rascunho local em uma alegação de entrega.
