# Backend Sienge — BFF

Servidor Node.js que faz a ponte segura entre o site e a API do Sienge.

## Deploy no Render (grátis)

1. Acesse render.com e crie uma conta
2. New → Web Service → conecte este repositório
3. Root Directory: `backend`
4. Build Command: `npm install`
5. Start Command: `node backend-sienge.js`
6. Em **Environment Variables**, adicione:
   - `SIENGE_SUBDOMAIN` = macedofortes
   - `SIENGE_USER` = macedofortes-luizmacedo
   - `SIENGE_PASSWORD` = (sua senha da API)
   - `APP_TOKEN` = sienge-macedo-2026

Após deploy, a URL pública vai aparecer no Render (ex.: https://sienge-backend.onrender.com).
Cole essa URL na aba **Conexão** do site + o APP_TOKEN.
