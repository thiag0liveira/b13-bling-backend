// =============================================================================
// B13 Bebidas — Backend de integração com o Bling ERP (API v3, OAuth 2.0)
// Versão 2 — com rotas de diagnóstico (categorias, produto detalhado, raw)
//            e persistência opcional dos tokens em disco (DATA_DIR).
// -----------------------------------------------------------------------------
// Rotas:
//   GET  /auth                      -> inicia o login no Bling
//   GET  /callback                  -> recebe o código e salva os tokens
//   GET  /status                    -> mostra se está conectado
//   GET  /api/produtos              -> lista produtos (preço padrão)
//   GET  /api/categorias            -> lista categorias (árvore pai->filho)
//   GET  /api/produto/:id           -> detalhe completo de UM produto
//   GET  /api/raw?path=/qualquer    -> chamada GET livre p/ diagnóstico
//   GET  /api/contatos?doc=...      -> busca contato por CPF/CNPJ
//   POST /api/pedido                -> cria um pedido de venda
// =============================================================================

import express from "express";
import cors from "cors";
import fs from "fs";
import "dotenv/config";

const {
  BLING_CLIENT_ID,
  BLING_CLIENT_SECRET,
  BLING_REDIRECT_URI = "http://localhost:3000/callback",
  PORT = 3000,
  DATA_DIR = ".", // se apontar para um Volume do Railway, os tokens ficam permanentes
} = process.env;

const AUTH_URL = "https://www.bling.com.br/Api/v3/oauth/authorize";
const TOKEN_URL = "https://api.bling.com.br/Api/v3/oauth/token";
const API = "https://api.bling.com.br/Api/v3";
const TOKENS_FILE = `${DATA_DIR}/tokens.json`;

const app = express();
app.use(cors());
app.use(express.json());

function lerTokens() { try { return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); } catch { return null; } }
function salvarTokens(t) { t.obtido_em = Date.now(); fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); }
function basicAuth() { return "Basic " + Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString("base64"); }

async function trocarCodePorToken(code) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: BLING_REDIRECT_URI });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0", Authorization: basicAuth() }, body });
  if (!r.ok) throw new Error("Falha ao obter token: " + (await r.text()));
  const t = await r.json(); salvarTokens(t); return t;
}
async function renovarToken(refresh_token) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0", Authorization: basicAuth() }, body });
  if (!r.ok) throw new Error("Falha ao renovar token: " + (await r.text()));
  const t = await r.json(); salvarTokens(t); return t;
}
async function getAccessToken() {
  let t = lerTokens();
  if (!t) throw new Error("Ainda não conectado ao Bling. Acesse /auth para autorizar.");
  const expiraEm = t.obtido_em + (t.expires_in - 60) * 1000;
  if (Date.now() >= expiraEm) t = await renovarToken(t.refresh_token);
  return t.access_token;
}
async function bling(path, options = {}) {
  const token = await getAccessToken();
  const r = await fetch(API + path, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...(options.headers || {}) } });
  const texto = await r.text();
  let json; try { json = texto ? JSON.parse(texto) : {}; } catch { json = { raw: texto }; }
  if (!r.ok) throw Object.assign(new Error("Erro Bling " + r.status), { status: r.status, body: json });
  return json;
}
const soDigitos = (s) => (s || "").replace(/\D/g, "");

// ------------------------------- OAuth ---------------------------------------
app.get("/auth", (req, res) => {
  res.redirect(`${AUTH_URL}?response_type=code&client_id=${BLING_CLIENT_ID}&state=b13${Date.now()}`);
});
app.get("/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Sem 'code' na URL.");
    await trocarCodePorToken(code);
    res.send("<h2>✅ Conta Bling conectada!</h2><p>Já pode fechar esta aba. Teste em <a href='/status'>/status</a> e <a href='/api/produtos'>/api/produtos</a>.</p>");
  } catch (e) { res.status(500).send("Erro no callback: " + e.message); }
});
app.get("/status", (req, res) => {
  const t = lerTokens();
  if (!t) return res.json({ conectado: false, dica: "Acesse /auth para conectar." });
  res.json({ conectado: true, expira_em_segundos: Math.round((t.obtido_em + t.expires_in * 1000 - Date.now()) / 1000) });
});

// ------------------------------- Dados ---------------------------------------
app.get("/api/produtos", async (req, res) => {
  try {
    const pagina = req.query.pagina || 1, limite = req.query.limite || 100;
    res.json(await bling(`/produtos?pagina=${pagina}&limite=${limite}`));
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// DIAGNÓSTICO: lista as categorias (com categoriaPai)
app.get("/api/categorias", async (req, res) => {
  try { res.json(await bling(`/categorias/produtos?limite=100`)); }
  catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// DIAGNÓSTICO: detalhe completo de UM produto (pra vermos categoria e preços)
app.get("/api/produto/:id", async (req, res) => {
  try { res.json(await bling(`/produtos/${req.params.id}`)); }
  catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// DIAGNÓSTICO: chamada GET livre. Ex.: /api/raw?path=/produtos?idCategoria=123
app.get("/api/raw", async (req, res) => {
  try {
    const path = req.query.path;
    if (!path || !path.startsWith("/")) return res.status(400).json({ erro: "Use ?path=/algum/endpoint" });
    res.json(await bling(path));
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// ------------------------------- Contatos / Pedido ---------------------------
app.get("/api/contatos", async (req, res) => {
  try {
    const doc = soDigitos(req.query.doc);
    if (!doc) return res.status(400).json({ erro: "Informe ?doc=CPF_ou_CNPJ" });
    const dados = await bling(`/contatos?pesquisa=${encodeURIComponent(doc)}`);
    const lista = dados?.data || [];
    const achado = lista.find((c) => soDigitos(c.numeroDocumento) === doc) || null;
    res.json({ encontrado: !!achado, contato: achado, brutos: lista });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});
app.post("/api/pedido", async (req, res) => {
  try {
    const { contatoId, itens } = req.body;
    if (!contatoId || !Array.isArray(itens) || !itens.length)
      return res.status(400).json({ erro: "Envie { contatoId, itens:[{produtoId, quantidade, valor}] }" });
    const payload = { contato: { id: Number(contatoId) }, itens: itens.map((i) => ({ produto: { id: Number(i.produtoId) }, quantidade: Number(i.quantidade), valor: Number(i.valor) })) };
    res.json(await bling(`/pedidos/vendas`, { method: "POST", body: JSON.stringify(payload) }));
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

// Busca produtos por nome (para o vínculo na ferramenta de tabela)
app.get("/api/buscar", async (req, res) => {
  try {
    const nome = (req.query.nome || "").trim();
    if (nome.length < 2) return res.json({ data: [] });
    const dados = await bling(`/produtos?nome=${encodeURIComponent(nome)}&limite=100`);
    let lista = (dados.data || []).map((p) => ({ id: p.id, nome: p.nome, codigo: p.codigo, estoque: p.estoque?.saldoVirtualTotal ?? null }));
    const termo = nome.toLowerCase();
    const filtrada = lista.filter((p) => (p.nome || "").toLowerCase().includes(termo));
    res.json({ data: filtrada.length ? filtrada : lista });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message, body: e.body }); }
});

app.get("/", (req, res) => res.send("B13 Bling Backend rodando. Comece em <a href='/auth'>/auth</a>."));
app.listen(PORT, () => console.log(`B13 Bling Backend em http://localhost:${PORT} (DATA_DIR=${DATA_DIR})`));
