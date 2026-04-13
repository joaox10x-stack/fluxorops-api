const express = require("express");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { v4: uuidv4 } = require("uuid");

// ── Firebase ──────────────────────────────────────────────────────────────────
// Corrige o \n da private_key que fica corrompido em variáveis de ambiente
const firebaseCreds = JSON.parse(process.env.FIREBASE_CREDENTIALS);
firebaseCreds.private_key = firebaseCreds.private_key.replace(/\\n/g, "\n");
initializeApp({ credential: cert(firebaseCreds) });
const db = getFirestore();

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/health") return next();
  if (req.headers["x-api-key"] !== process.env.API_KEY) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const hoje = () => new Date().toISOString().split("T")[0];
const fmtStatus = (s) =>
  ({ pendente: "Pendente", em_rota: "Em rota", concluido: "Concluído" }[s] || s);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("FluxorOps API 🚀"));
app.get("/health", (req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() })
);

// ─────────────────────────────────────────────────────────────────────────────
// CONSULTAS
// ─────────────────────────────────────────────────────────────────────────────

// GET /consulta/montador?empresa=ID&nome=João&data=YYYY-MM-DD
app.get("/consulta/montador", async (req, res) => {
  const { empresa, nome, data } = req.query;
  if (!empresa || !nome)
    return res.status(400).json({ error: '"empresa" e "nome" obrigatórios.' });

  const snap = await db
    .collection("empresas").doc(empresa)
    .collection("pedidos")
    .where("dataAgendada", "==", data || hoje())
    .get();

  const nomeNorm = nome.toLowerCase().trim();
  const pedidos = snap.docs
    .map((d) => d.data())
    .filter((p) => p.montador?.toLowerCase().includes(nomeNorm));

  res.json({
    empresa, montador_busca: nome, data: data || hoje(), total: pedidos.length,
    pedidos: pedidos.map((p) => ({
      id: p.id, nf: p.nf, cliente: p.cliente,
      endereco: p.endereco, itens: p.itens,
      status: fmtStatus(p.status), montador: p.montador,
    })),
  });
});

// GET /consulta/nf?empresa=ID&nf=128782
app.get("/consulta/nf", async (req, res) => {
  const { empresa, nf } = req.query;
  if (!empresa || !nf)
    return res.status(400).json({ error: '"empresa" e "nf" obrigatórios.' });

  const [pedSnap, entSnap] = await Promise.all([
    db.collection("empresas").doc(empresa).collection("pedidos")
      .where("nf", "==", String(nf)).limit(5).get(),
    db.collection("empresas").doc(empresa).collection("entregas")
      .where("nf", "==", String(nf)).limit(5).get(),
  ]);

  const resultados = [
    ...pedSnap.docs.map((d) => ({ tipo: "montagem", ...d.data() })),
    ...entSnap.docs.map((d) => ({ tipo: "entrega", ...d.data() })),
  ];

  res.json({
    empresa, nf, total: resultados.length,
    resultados: resultados.map((r) => ({
      tipo: r.tipo, nf: r.nf, cliente: r.cliente,
      status: fmtStatus(r.status),
      responsavel: r.montador || r.motorista || "—",
      endereco: r.endereco, data: r.dataAgendada || r.dataEntrega,
    })),
  });
});

// GET /consulta/status?empresa=ID&status=pendente&data=YYYY-MM-DD
app.get("/consulta/status", async (req, res) => {
  const { empresa, status, data } = req.query;
  if (!empresa || !status)
    return res.status(400).json({ error: '"empresa" e "status" obrigatórios.' });

  const s = status.toLowerCase().replace(" ", "_");
  const validos = ["pendente", "em_rota", "concluido"];
  if (!validos.includes(s))
    return res.status(400).json({ error: `Status inválido. Use: ${validos.join(", ")}` });

  const dataFiltro = data || hoje();
  const [pedSnap, entSnap] = await Promise.all([
    db.collection("empresas").doc(empresa).collection("pedidos")
      .where("status", "==", s).where("dataAgendada", "==", dataFiltro).get(),
    db.collection("empresas").doc(empresa).collection("entregas")
      .where("status", "==", s).where("dataEntrega", "==", dataFiltro).get(),
  ]);

  const itens = [
    ...pedSnap.docs.map((d) => ({ tipo: "montagem", ...d.data() })),
    ...entSnap.docs.map((d) => ({ tipo: "entrega", ...d.data() })),
  ];

  res.json({
    empresa, status: s, data: dataFiltro, total: itens.length,
    itens: itens.map((r) => ({
      tipo: r.tipo, nf: r.nf, cliente: r.cliente,
      responsavel: r.montador || r.motorista || "—", endereco: r.endereco,
    })),
  });
});

// GET /consulta/resumo?empresa=ID&data=YYYY-MM-DD
app.get("/consulta/resumo", async (req, res) => {
  const { empresa, data } = req.query;
  if (!empresa)
    return res.status(400).json({ error: '"empresa" obrigatório.' });

  const dataFiltro = data || hoje();
  const [pedSnap, entSnap] = await Promise.all([
    db.collection("empresas").doc(empresa).collection("pedidos")
      .where("dataAgendada", "==", dataFiltro).get(),
    db.collection("empresas").doc(empresa).collection("entregas")
      .where("dataEntrega", "==", dataFiltro).get(),
  ]);

  const contar = (docs) =>
    docs.reduce((acc, d) => {
      const s = d.data().status || "pendente";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

  res.json({
    empresa, data: dataFiltro,
    montagens: { total: pedSnap.size, ...contar(pedSnap.docs) },
    entregas:  { total: entSnap.size, ...contar(entSnap.docs) },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRIAÇÃO
// ─────────────────────────────────────────────────────────────────────────────
app.post("/pedidos", async (req, res) => {
  const { empresa, pedidos } = req.body;
  if (!empresa)
    return res.status(400).json({ error: '"empresa" obrigatório.' });
  if (!Array.isArray(pedidos) || !pedidos.length)
    return res.status(400).json({ error: '"pedidos" deve ser array não vazio.' });

  const empSnap = await db.collection("empresas").doc(empresa).get();
  if (!empSnap.exists)
    return res.status(404).json({ error: `Empresa "${empresa}" não encontrada.` });

  const batch = db.batch();
  const criados = [], erros = [];

  for (let i = 0; i < pedidos.length; i++) {
    const p = pedidos[i];
    if (!p.cliente || !p.nf || !p.endereco || !p.dataAgendada) {
      erros.push({ index: i, nf: p.nf || "?", erro: "Campos obrigatórios faltando." });
      continue;
    }
    const id = uuidv4();
    batch.set(
      db.collection("empresas").doc(empresa).collection("pedidos").doc(id),
      {
        id, cliente: p.cliente.trim(), nf: String(p.nf).trim(),
        montador: p.montador?.trim() || "", endereco: p.endereco.trim(),
        itens: p.itens?.trim() || "", observacao: p.observacao?.trim() || "",
        dataAgendada: p.dataAgendada, status: "pendente",
        criadoEm: Timestamp.now(), origem: "api", foto: null, fotoUrl: null,
      }
    );
    criados.push({ index: i, id, nf: p.nf });
  }

  if (criados.length) await batch.commit();
  res.status(207).json({
    message: `${criados.length} criado(s), ${erros.length} erro(s).`,
    criados, erros,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () =>
  console.log(`FluxorOps API rodando na porta ${process.env.PORT || 3000}`)
);
