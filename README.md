# OKR Academia PX — GitHub Pages

Versão estática do painel pronta para publicação no GitHub Pages. Os dados continuam no Google Sheets e são acessados pelo Google Apps Script após o login.

## Antes de publicar

1. Faça o deploy da versão segura do backend como **Aplicativo da Web** no Google Apps Script.
2. Em `config.js`, cole a URL terminada em `/exec` no campo `appsScriptUrl`.
3. Não adicione senhas, tokens, planilhas ou dados pessoais neste repositório.

## Publicação

1. Crie um repositório vazio no GitHub.
2. Envie todo o conteúdo desta pasta para a branch `main`, preservando a pasta `.github`.
3. No repositório, acesse **Settings > Pages**.
4. Em **Build and deployment > Source**, selecione **GitHub Actions**.
5. Abra a aba **Actions** e aguarde o fluxo **Publicar no GitHub Pages** concluir.

O endereço publicado será exibido no resultado do fluxo e normalmente seguirá o formato `https://USUARIO.github.io/REPOSITORIO/`.

## Segurança

GitHub Pages publica os arquivos do navegador. Este pacote não contém dados mensais, nomes da equipe, credenciais ou código do backend. O backend deve validar a sessão e as permissões em todas as operações.
