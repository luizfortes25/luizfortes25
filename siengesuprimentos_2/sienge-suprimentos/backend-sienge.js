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
const crypto = require("crypto");

const app = express();
const path = require("path");
app.use(cors());          // em producao, restrinja ao dominio do app
app.use(express.json());
// Serve o site (index.html) no mesmo endereco do backend.
// Assim basta UMA hospedagem (ex.: Render) e voce abre tudo pela URL publica.
app.use(express.static(__dirname));

const { SIENGE_SUBDOMAIN, SIENGE_USER, SIENGE_PASSWORD, APP_TOKEN, DATABASE_URL, PORT = 3001 } = process.env;

// Modulos de acesso que o admin pode liberar por usuario.
const ALL_PERMS = ["orders", "new", "stock", "nfes", "flow", "endpoints"];

// Perfis de acesso.
const ADMIN_ROLE = "administrador";
const PROFILES = ["administrador", "aprovador", "operador"];
function normalizeRole(r) { return PROFILES.indexOf(r) !== -1 ? r : "operador"; }
function isApprover(r) { return r === "administrador" || r === "aprovador"; }

// ============================================================
//  BANCO DE DADOS (usuarios) — PostgreSQL
// ============================================================
let pool = null;
if (DATABASE_URL) {
  try {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb`);
      // Migra perfis antigos para os novos nomes.
      await pool.query(`UPDATE users SET role='administrador' WHERE role IN ('superadmin','admin')`);
      await pool.query(`UPDATE users SET role='operador' WHERE role='user'`);
      // Garante o administrador a partir das variaveis de ambiente (senha nunca fica no codigo).
      const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
      if (ADMIN_EMAIL && ADMIN_PASSWORD) {
        const adminLogin = String(ADMIN_EMAIL).toLowerCase().trim();
        await pool.query(
          `INSERT INTO users(full_name, email, password_hash, role, permissions) VALUES($1,$2,$3,'administrador',$4::jsonb)
           ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, full_name=EXCLUDED.full_name, role='administrador', permissions=EXCLUDED.permissions`,
          [String(ADMIN_NAME || "Administrador"), adminLogin, hashPassword(String(ADMIN_PASSWORD)), JSON.stringify(ALL_PERMS)]
        );
        console.log("Administrador garantido:", adminLogin);
      }
      console.log("Banco pronto.");
    })().catch((e) => console.error("Erro ao inicializar o banco:", e.message));
  } catch (e) { console.error("Falha ao iniciar o banco (pg):", e.message); }
}

// ---- seguranca de senha (scrypt nativo do Node, sem dependencia extra) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(pw, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 2) return false;
  const hash = crypto.scryptSync(String(pw), parts[0], 64).toString("hex");
  const a = Buffer.from(hash), b = Buffer.from(parts[1]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- token de sessao assinado (stateless) ----
const SESSION_SECRET = APP_TOKEN || "sienge-session-secret";
function makeSessionToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, email: user.email, role: user.role || "user", exp: Date.now() + 7 * 24 * 3600 * 1000 })).toString("base64");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return payload + "." + sig;
}
function verifySessionToken(tok) {
  const parts = String(tok || "").split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(parts[0]).digest("hex");
  if (expected !== parts[1]) return null;
  try { const d = JSON.parse(Buffer.from(parts[0], "base64").toString()); if (d.exp < Date.now()) return null; return d; } catch (e) { return null; }
}

function publicUser(u) {
  return { id: u.id, fullName: u.full_name, email: u.email, role: u.role, permissions: u.permissions || [] };
}

const AP = "/api/auth";
// Cadastro publico DESATIVADO: novos usuarios sao criados apenas pelo administrador.
app.post(`${AP}/register`, (req, res) => res.status(403).json({ error: "O cadastro e feito apenas pelo administrador." }));
app.post(`${AP}/login`, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Banco de dados nao configurado (defina DATABASE_URL)" });
  try {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const password = String((req.body && req.body.password) || "");
    if (!email || !password) return res.status(400).json({ error: "Informe e-mail e senha" });
    const r = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (!r.rows.length || !verifyPassword(password, r.rows[0].password_hash)) return res.status(401).json({ error: "E-mail ou senha invalidos" });
    const u = r.rows[0];
    res.json({ token: makeSessionToken(u), user: publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erro ao entrar" }); }
});
app.get(`${AP}/me`, async (req, res) => {
  const d = verifySessionToken((req.headers.authorization || "").replace("Bearer ", ""));
  if (!d) return res.status(401).json({ error: "Nao autenticado" });
  if (!pool) return res.json({ id: d.id, email: d.email, role: d.role, permissions: [] });
  try {
    const r = await pool.query("SELECT * FROM users WHERE id=$1", [d.id]);
    if (!r.rows.length) return res.status(401).json({ error: "Usuario nao encontrado" });
    res.json(publicUser(r.rows[0]));
  } catch (e) { res.json({ id: d.id, email: d.email, role: d.role, permissions: [] }); }
});
// Informa se o login esta ativo (so exige acesso quando o banco esta configurado).
app.get(`${AP}/enabled`, (req, res) => res.json({ enabled: !!pool }));

// ============================================================
//  ADMIN — gestao de usuarios (apenas super-admin)
// ============================================================
function requireAdmin(req, res, next) {
  const d = verifySessionToken((req.headers.authorization || "").replace("Bearer ", ""));
  if (!d) return res.status(401).json({ error: "Nao autenticado" });
  if (d.role !== ADMIN_ROLE && d.role !== "superadmin") return res.status(403).json({ error: "Apenas administradores" });
  req.authUser = d;
  next();
}
const ADM = "/api/admin";
app.get(`${ADM}/users`, requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Banco nao configurado" });
  try {
    const r = await pool.query("SELECT id, full_name, email, role, permissions FROM users ORDER BY id");
    res.json(r.rows.map(publicUser));
  } catch (e) { console.error(e); res.status(500).json({ error: "Erro ao listar usuarios" }); }
});
app.post(`${ADM}/users`, requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Banco nao configurado" });
  try {
    const b = req.body || {};
    const fullName = String(b.fullName || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    const role = normalizeRole(b.role);
    const perms = Array.isArray(b.permissions) ? b.permissions.filter((p) => ALL_PERMS.indexOf(p) !== -1) : [];
    if (!fullName || !email || !password) return res.status(400).json({ error: "Preencha nome, e-mail e senha" });
    if (password.length < 6) return res.status(400).json({ error: "A senha deve ter ao menos 6 caracteres" });
    const r = await pool.query(
      "INSERT INTO users(full_name, email, password_hash, role, permissions) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id, full_name, email, role, permissions",
      [fullName, email, hashPassword(password), role, JSON.stringify(role === ADMIN_ROLE ? ALL_PERMS : perms)]
    );
    res.json(publicUser(r.rows[0]));
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Este e-mail ja esta cadastrado" });
    console.error(e); res.status(500).json({ error: "Erro ao criar usuario" });
  }
});
app.patch(`${ADM}/users/:id`, requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Banco nao configurado" });
  try {
    const b = req.body || {}, sets = [], vals = []; let i = 1;
    if (b.role !== undefined) { sets.push(`role=$${i++}`); vals.push(normalizeRole(b.role)); }
    if (b.permissions !== undefined) { const perms = Array.isArray(b.permissions) ? b.permissions.filter((p) => ALL_PERMS.indexOf(p) !== -1) : []; sets.push(`permissions=$${i++}::jsonb`); vals.push(JSON.stringify(normalizeRole(b.role) === ADMIN_ROLE ? ALL_PERMS : perms)); }
    if (b.fullName !== undefined) { sets.push(`full_name=$${i++}`); vals.push(String(b.fullName)); }
    if (b.password) { if (String(b.password).length < 6) return res.status(400).json({ error: "A senha deve ter ao menos 6 caracteres" }); sets.push(`password_hash=$${i++}`); vals.push(hashPassword(String(b.password))); }
    if (!sets.length) return res.status(400).json({ error: "Nada para atualizar" });
    vals.push(Number(req.params.id));
    const r = await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${i} RETURNING id, full_name, email, role, permissions`, vals);
    if (!r.rows.length) return res.status(404).json({ error: "Usuario nao encontrado" });
    res.json(publicUser(r.rows[0]));
  } catch (e) { console.error(e); res.status(500).json({ error: "Erro ao atualizar" }); }
});
app.delete(`${ADM}/users/:id`, requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Banco nao configurado" });
  try {
    const id = Number(req.params.id);
    if (id === req.authUser.id) return res.status(400).json({ error: "Voce nao pode excluir a si mesmo" });
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erro ao excluir" }); }
});

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
  const auth = req.headers.authorization || "";
  const tok = auth.replace("Bearer ", "");
  if (auth === `Bearer ${APP_TOKEN}`) return next();   // token fixo do app
  if (verifySessionToken(tok)) return next();          // usuario logado (sessao)
  return res.status(401).json({ error: "Nao autorizado" });
}
// So Administrador e Aprovador podem aprovar/reprovar.
function requireApprover(req, res, next) {
  const auth = req.headers.authorization || "";
  const tok = auth.replace("Bearer ", "");
  if (APP_TOKEN && auth === `Bearer ${APP_TOKEN}`) return next();
  const d = verifySessionToken(tok);
  if (d && isApprover(d.role)) return next();
  return res.status(403).json({ error: "Seu perfil nao permite aprovar ou reprovar" });
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
      building: o.buildingName ?? o.building ?? (o.buildingId != null ? `Obra ${o.buildingId}` : "—"),
      supplier: o.supplierName ?? o.supplier ?? (o.supplierId != null ? `Forn. ${o.supplierId}` : "—"),
      value: o.totalValue ?? o.value ?? o.totalAmount ?? 0,
      status: (o.authorized === true || o.authorizedAt) ? "AUTHORIZED"
              : (o.disapproved === true) ? "DISAPPROVED"
              : mapStatus(o.consistencyStatus ?? o.authorizationStatus ?? o.status),
      items: o.itemsCount ?? o.items ?? 0,
      delivery: o.deliveryForecast ?? o.delivery ?? o.date ?? null,
    }));
    res.json(results);
  } catch (e) { fail(res, e); }
});
app.get(`${P}/purchase-orders/:id`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/purchase-orders/${req.params.id}`)); } catch (e) { fail(res, e); }
});
app.get(`${P}/purchase-orders/:id/items`, requireAppToken, async (req, res) => {
  try {
    const data = await sienge("GET", `/purchase-orders/${req.params.id}/items`);
    const results = (data.results || data || []).map((it) => {
      const qty = it.quantity ?? 0;
      const unitPrice = it.netPrice ?? it.unitPrice ?? 0;
      return {
        n: it.itemNumber ?? null,
        resource: it.resourceDescription ?? it.resource ?? "—",
        brand: it.trademarkDescription || "—",
        qty: qty,
        unit: it.unitOfMeasure ?? "UN",
        unitPrice: unitPrice,
        total: it.totalPrice ?? (qty * unitPrice),
      };
    });
    res.json(results);
  } catch (e) { fail(res, e); }
});
app.get(`${P}/purchase-orders/:id/totalization`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/purchase-orders/${req.params.id}/totalization`)); } catch (e) { fail(res, e); }
});

// ---- DEBUG temporario: ver o JSON CRU do Sienge (remover depois) ----
// Aceita o token pela URL (?token=...) para abrir direto no navegador.
function debugAuth(req, res, next) {
  const t = req.query.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!APP_TOKEN || t === APP_TOKEN || verifySessionToken(t)) return next();
  return res.status(401).json({ error: "Token do app invalido" });
}
app.get(`${P}/_raw/*`, debugAuth, async (req, res) => {
  try {
    const resource = req.params[0];
    const qs = new URLSearchParams(req.query); qs.delete("token");
    const q = qs.toString();
    res.json(await sienge("GET", `/${resource}${q ? "?" + q : ""}`));
  } catch (e) { fail(res, e); }
});

// ---- PDF de analise do pedido (binario) ----
// Aceita token via ?token=... para abrir direto numa aba do navegador.
app.get(`${P}/purchase-orders/:id/analysis/pdf`, debugAuth, async (req, res) => {
  try {
    if (!withinRateLimit()) return res.status(429).json({ error: "Rate limit local (180/min)" });
    const r = await fetch(`${SIENGE_BASE}/purchase-orders/${req.params.id}/analysis/pdf`, {
      headers: { Authorization: SIENGE_AUTH, Accept: "*/*" },
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: `Sienge ${r.status}`, detail: t.slice(0, 400) });
    }
    const ct = r.headers.get("content-type") || "application/pdf";
    const buf = Buffer.from(await r.arrayBuffer());
    if (ct.includes("application/json")) { res.setHeader("Content-Type", "application/json"); return res.send(buf); }
    res.setHeader("Content-Type", ct.includes("pdf") || ct.includes("octet") ? "application/pdf" : ct);
    res.setHeader("Content-Disposition", `inline; filename="pedido-${req.params.id}.pdf"`);
    res.send(buf);
  } catch (e) { fail(res, e); }
});

// ============================================================
//  PEDIDOS — escrita (autorizar / reprovar / anexo / avaliacao)
// ============================================================
// Autorizar (PUT)
app.put(`${P}/purchase-orders/:id/authorize`, requireApprover, async (req, res) => {
  try { res.json(await sienge("PUT", `/purchase-orders/${req.params.id}/authorize`)); } catch (e) { fail(res, e); }
});
// Autorizar com observacao (PATCH)
app.patch(`${P}/purchase-orders/:id/authorize`, requireApprover, async (req, res) => {
  try { res.json(await sienge("PATCH", `/purchase-orders/${req.params.id}/authorize`, req.body)); } catch (e) { fail(res, e); }
});
// Reprovar (PUT)
app.put(`${P}/purchase-orders/:id/disapprove`, requireApprover, async (req, res) => {
  try { res.json(await sienge("PUT", `/purchase-orders/${req.params.id}/disapprove`)); } catch (e) { fail(res, e); }
});
// Reprovar com observacao (PATCH)
app.patch(`${P}/purchase-orders/:id/disapprove`, requireApprover, async (req, res) => {
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
// Criar solicitacao (le o ID no corpo OU no cabecalho Location)
app.post(`${P}/purchase-requests`, requireAppToken, async (req, res) => {
  try {
    if (!withinRateLimit()) return res.status(429).json({ error: "Rate limit local (180/min)" });
    const resp = await fetch(`${SIENGE_BASE}/purchase-requests`, {
      method: "POST",
      headers: { Authorization: SIENGE_AUTH, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const text = await resp.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!resp.ok) return res.status(resp.status).json({ error: `Sienge ${resp.status}`, detail: data });
    let id = data && (data.purchaseRequestId ?? data.id);
    if (!id) { const m = (resp.headers.get("location") || "").match(/(\d+)\/?$/); if (m) id = Number(m[1]); }
    res.json({ purchaseRequestId: id ?? null, raw: data });
  } catch (e) { fail(res, e); }
});
// Adicionar itens
app.post(`${P}/purchase-requests/:id/items`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("POST", `/purchase-requests/${req.params.id}/items`, req.body)); } catch (e) { fail(res, e); }
});
// Autorizar / reprovar solicitacao inteira
app.patch(`${P}/purchase-requests/:id/authorize`, requireApprover, async (req, res) => {
  try { res.json(await sienge("PATCH", `/purchase-requests/${req.params.id}/authorize`, req.body)); } catch (e) { fail(res, e); }
});
app.patch(`${P}/purchase-requests/:id/disapproval`, requireApprover, async (req, res) => {
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

// ============================================================
//  NOTAS FISCAIS (NF-e) — leitura
// ============================================================
app.get(`${P}/nfes`, requireAppToken, async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await sienge("GET", `/nfes${qs ? "?" + qs : ""}`);
    const results = (data.results || data || []).map((n) => ({
      id: n.id ?? n.nfeId,
      number: n.number ?? n.nfeNumber ?? "-",
      series: n.series ?? "-",
      supplier: n.supplierName ?? n.issuerName ?? n.supplier ?? "-",
      value: n.totalValue ?? n.value ?? 0,
      issueDate: n.issueDate ?? n.emissionDate ?? null,
      status: n.status ?? "Recebida",
      accessKey: n.accessKey ?? n.nfeKey ?? "-",
    }));
    res.json(results);
  } catch (e) { fail(res, e); }
});
app.get(`${P}/nfes/:id`, requireAppToken, async (req, res) => {
  try { res.json(await sienge("GET", `/nfes/${req.params.id}`)); } catch (e) { fail(res, e); }
});
// Rastreio: insumos de pedidos atendidos por notas fiscais
app.get(`${P}/purchase-invoices/deliveries-attended`, requireAppToken, async (req, res) => {
  try { const qs = new URLSearchParams(req.query).toString(); res.json(await sienge("GET", `/purchase-invoices/deliveries-attended${qs ? "?" + qs : ""}`)); } catch (e) { fail(res, e); }
});

// Health check
app.get(`${P}/health`, (req, res) => res.json({ ok: true, base: SIENGE_BASE }));

app.listen(PORT, () => {
  console.log(`Backend Sienge na porta ${PORT}`);
  console.log(`Base da API: ${SIENGE_BASE}`);
});
