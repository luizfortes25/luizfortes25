# Sienge Suprimentos — Sistema Web

Sistema web de **Suprimentos e Estoque** integrado à API do Sienge.
Tem duas partes:

- **`index.html`** — o site (frontend) que a equipe abre no navegador.
- **`backend-sienge.js`** — o servidor (BFF) que guarda as credenciais do Sienge e faz a ponte segura com a API.

---

## Pré-requisitos

- Node.js 18 ou superior instalado.
- Credenciais da API do Sienge (usuário e senha gerados na área de Integrações/APIs do Sienge).
- Conta Sienge do tipo **DC (nuvem)** — em servidor local a API não fica disponível.

---

## Passo a passo (rodar localmente)

1. **Instale as dependências:**
   ```
   npm install
   ```

2. **Configure as credenciais:**
   - Renomeie o arquivo `.env.example` para `.env`.
   - Abra o `.env` e preencha:
     - `SIENGE_SUBDOMAIN` — o subdomínio da empresa (o que aparece na URL: `SUAEMPRESA.sienge.com.br`).
     - `SIENGE_USER` e `SIENGE_PASSWORD` — as credenciais da API.
     - `APP_TOKEN` — invente um texto secreto qualquer (o mesmo você cola na aba Conexão do site).

3. **Inicie o backend:**
   ```
   npm start
   ```
   Você verá no terminal: `Backend Sienge na porta 3001`.

4. **Abra o site:**
   - Dê duplo clique no `index.html` (abre no navegador).
   - Vá na aba **Conexão**.
   - Em "URL do seu backend", coloque: `http://localhost:3001/api/sienge`
   - Em "Token", coloque o mesmo valor que pôs em `APP_TOKEN`.
   - Clique em **Conectar**.

5. Pronto. As abas Pedidos, Nova Solicitação e Estoque passam a usar os dados reais do Sienge.

---

## Publicar na internet (para a equipe acessar)

- **Backend:** suba esta pasta no Render, Railway ou Heroku. Configure as mesmas variáveis do `.env` no painel do serviço. Ele te dá uma URL pública (ex.: `https://seu-backend.onrender.com`).
- **Frontend:** suba o `index.html` no Netlify ou Vercel. Te dá uma URL pública (ex.: `https://seu-site.netlify.app`).
- No site publicado, na aba Conexão, use a URL pública do backend + `/api/sienge`.

---

## Segurança

- **Nunca** coloque as credenciais do Sienge dentro do `index.html` — elas ficam só no backend.
- O arquivo `.env` não deve ser enviado para repositórios públicos (GitHub). Mantenha-o privado.
- Em produção, restrinja o CORS no backend ao domínio do seu site.

---

## Endpoints cobertos

O backend expõe rotas para Solicitações, Pedidos e Estoque — tudo que a API do Sienge libera nesses módulos. Veja a aba **Endpoints** do site para a lista completa (39 endpoints).
