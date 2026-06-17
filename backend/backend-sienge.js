// ============================================================
//  Backend (BFF) — Sienge Suprimentos
//  Ponte segura entre o app web e a API REST do Sienge.
//  As credenciais ficam AQUI (servidor), nunca no navegador.
//
//  Como rodar:
//    1. npm init -y
//    2. npm install express cors
//    3. Defina as variaveis de ambiente (abaixo)
//    4. node backend-sienge.js
//    5. Publique no Render / Railway / Heroku e cole a URL
//       publica na aba "Conexao" do app.
//
//  Variaveis de ambiente:
//    SIENGE_SUBDOMAIN  -> subdominio da conta (ex.: minhaempresa)
//    SIENGE_USER       -> usuario da API (portal do Sienge)
//    SIENGE_PASSWORD   -> senha/token da API
//    APP_TOKEN         -> token que VOCE inventa p/ o app autenticar
//    PORT              -> (opcional) porta local, padrao 3001
// ============================================================

// Carrega variaveis do arquivo .env (se o pacote dotenv estiver instalado).
try { require("dotenv").config(); } catch (e) { /* dotenv opcional */ }

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());          // em producao, restrinja ao dominio do app
app.use(express.json());

const { SIENGE_SUBDOMAIN, SIENGE_USER, SIENGE_PASSWORD, APP_TOKEN, PORT = 3001 } = process.env;

const SIENGE_BASE = `https://api.sienge.com.br/${SIENGE_SUBDOMAIN}/public/api/v1`;
const SIENGE_AUTH = "Basic " + Buffer.from(`${SIENGE_USER}:${SIENGE_PASSWORD}`).toString("base64");

// ---- rate limiter (teto 200/min na API REST) ----
let windowStart = Date.now(), countInWindow = 0;
const LIMIT = 180;
function withinRateLimit() {
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; countInWindow = 0; }
  if (countInWindow >= LIMIT) return false;
  countInWindow++; return true;
}

// ---- autentica o APP (nao o Sienge) ----
function requireAppToken(req, res, next) {
  if (!APP_TOKEN) return next();
  if ((req.headers.authorization || "") === `Bearer ${APP_TOKEN}`) return next();
  return res.status(401).json({ error: "Token do app invalido" });
}

// ---- chamada generica ao Sienge ----
async function sienge(method, path, body) {
  if (!withinRateLimit()) { const e = new Error("Rate limit local (180/min)"); e.status = 429; throw e; }
  const resp = await fetch(`${SIENGE_BASE}${path}`, {
    method,
    headers: { Authorization: SIENGE_AUTH, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : null;
  if (!resp.ok) { const e = new Error(`Sienge ${resp.status}`); e.status = resp.status; e.payload = data; throw e; }
  return data;
}

function fail(res, e) { console.error(e); res.status(e.status || 500).json({ error: e.message, detail: e.payload }); }
function mapStatus(s) {
  const v = String(s || "").toUpperCase();
  if (v.includes("AGUARD") || v.includes("PENDING")) return "PENDING";
  if (v.includes("COTA") || v.includes("QUOT")) return "QUOTING";
  if (v.includes("REPROV") || v.includes("DISAPPROV")) return "DISAPPROVED";
  return "AUTHORIZED";
}

const P = "/api/sienge"; // prefixo das rotas

// ============================================================
//  PEDIDOS DE COMPRA — leitura
// ============================================================
app.get(`${P}/purchase-orders`, requireAppToken, async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await sienge("GET", `/purchase-orders${qs ? "?" + qs : ""}`);
    const results = (data.results || data || []).map((o) => ({
      id: o.purchaseOrderId ?? o.id,
      building: o.buildingName ?? o.building ?? "—",
      supplier: o.supplierName ?? o.supplier ?? "—",
      value: o.totalValue ?? o.value ?? 0,
      status: mapStatus(o.consistencyStatus ?? o.authorizationStatus ?? o.status),
      items: o.itemsCount ?? o.items ?? 0,
      delivery: o.deliveryForecast ?? o.delivery ?? null,
    }));
    res.json(results);
  } catch (e) { fail(res, e); }
});
app.get(`${P}/purchase-orders/:id`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/purchase-orders/${req.params.id}`)); } catch (e) { fail(res, e); }
});
app.get(`${P}/purchase-orders/:id/items`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/purchase-orders/${req.params.id}/items`)); } catch (e) { fail(res, e); }
});
app.get(`${P}/purchase-orders/:id/totalization`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/purchase-orders/${req.params.id}/totalization`)); } catch (e) { fail(res, e); }
});

// ============================================================
//  PEDIDOS — escrita (autorizar / reprovar / anexo / avaliacao)
// ============================================================
// Autorizar (PUT)
app.put(`${P}/purchase-orders/:id/authorize`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("PUT", `/purchase-orders/${req.params.id}/authorize`)); } catch (e) { fail(res, e); }
});
// Autorizar com observacao (PATCH)
app.patch(`${P}/purchase-orders/:id/authorize`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("PATCH", `/purchase-orders/${req.params.id}/authorize`, req.body)); } catch (e) { fail(res, e); }
});
// Reprovar (PUT)
app.put(`${P}/purchase-orders/:id/disapprove`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("PUT", `/purchase-orders/${req.params.id}/disapprove`)); } catch (e) { fail(res, e); }
});
// Reprovar com observacao (PATCH)
app.patch(`${P}/purchase-orders/:id/disapprove`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("PATCH", `/purchase-orders/${req.params.id}/disapprove`, req.body)); } catch (e) { fail(res, e); }
});
// Anexar arquivo
app.post(`${P}/purchase-orders/:id/attachments`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("POST", `/purchase-orders/${req.params.id}/attachments`, req.body)); } catch (e) { fail(res, e); }
});
// Avaliar fornecedor (POST) / atualizar (PUT)
app.post(`${P}/purchase-orders/:id/evaluation`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("POST", `/purchase-orders/${req.params.id}/evaluation`, req.body)); } catch (e) { fail(res, e); }
});
app.put(`${P}/purchase-orders/:id/evaluation`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("PUT", `/purchase-orders/${req.params.id}/evaluation`, req.body)); } catch (e) { fail(res, e); }
});

// ============================================================
//  SOLICITACOES DE COMPRA — leitura e escrita
// ============================================================
app.get(`${P}/purchase-requests/all/items`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/purchase-requests/all/items`)); } catch (e) { fail(res, e); }
});
app.get(`${P}/purchase-requests/:id`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/purchase-requests/${req.params.id}`)); } catch (e) { fail(res, e); }
});
// Criar solicitacao
app.post(`${P}/purchase-requests`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("POST", `/purchase-requests`, req.body)); } catch (e) { fail(res, e); }
});
// Adicionar itens
app.post(`${P}/purchase-requests/:id/items`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("POST", `/purchase-requests/${req.params.id}/items`, req.body)); } catch (e) { fail(res, e); }
});
// Autorizar / reprovar solicitacao inteira
app.patch(`${P}/purchase-requests/:id/authorize`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("PATCH", `/purchase-requests/${req.params.id}/authorize`, req.body)); } catch (e) { fail(res, e); }
});
app.patch(`${P}/purchase-requests/:id/disapproval`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("PATCH", `/purchase-requests/${req.params.id}/disapproval`, req.body)); } catch (e) { fail(res, e); }
});

// ============================================================
//  MOVIMENTO DE ESTOQUE — leitura e escrita
// ============================================================
// Itens em estoque de um centro de custo
app.get(`${P}/stock-inventories/:costCenterId/items`, requireAppToken, async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await sienge("GET", `/stock-inventories/${req.params.costCenterId}/items${qs ? "?" + qs : ""}`);
    const results = (data.results || data || []).map((it) => ({
      resource: it.resourceDescription ?? it.resource ?? "—",
      brand: it.brandName ?? it.brand ?? "-",
      qty: it.stockQuantity ?? it.quantity ?? it.qty ?? 0,
      unit: it.unitOfMeasureSymbol ?? it.unit ?? "UN",
      cc: it.costCenterName ?? req.params.costCenterId,
    }));
    res.json(results);
  } catch (e) { fail(res, e); }
});
// Apropriacoes de obra do insumo em estoque
app.get(`${P}/stock-inventories/:costCenterId/items/:resourceId/building-appropriation`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/stock-inventories/${req.params.costCenterId}/items/${req.params.resourceId}/building-appropriation`)); } catch (e) { fail(res, e); }
});
// Reservas
app.get(`${P}/stock-reservations`, requireAppToken, async (req, res) => {
  try { const qs = new URLSearchParams(req.query).toString(); res.json(await sienge("GET", `/stock-reservations${qs ? "?" + qs : ""}`)); } catch (e) { fail(res, e); }
});
app.get(`${P}/stock-reservations/:reservationId/items`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/stock-reservations/${req.params.reservationId}/items`)); } catch (e) { fail(res, e); }
});
// Movimento que atende a reserva
app.post(`${P}/stock-reservations/:reservationId/movements`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("POST", `/stock-reservations/${req.params.reservationId}/movements`, req.body)); } catch (e) { fail(res, e); }
});
// Movimentos de estoque (listar / criar entrada-saida)
app.get(`${P}/stock-movements`, requireAppToken, async (req, res) => {
  try { const qs = new URLSearchParams(req.query).toString(); res.json(await sienge("GET", `/stock-movements${qs ? "?" + qs : ""}`)); } catch (e) { fail(res, e); }
});
app.post(`${P}/stock-movements`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("POST", `/stock-movements`, req.body)); } catch (e) { fail(res, e); }
});

// Health check
app.get(`${P}/health`, (req, res) => res.json({ ok: true, base: SIENGE_BASE }));

app.listen(PORT, () => {
  console.log(`Backend Sienge na porta ${PORT}`);
  console.log(`Base da API: ${SIENGE_BASE}`);
});
