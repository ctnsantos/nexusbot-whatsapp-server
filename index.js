const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());


// ============================================
// 🔧 COLE A URL DO WEBHOOK AQUI
// ============================================
const WEBHOOK_URL = "https://efnoqbrexeojxccfqsfy.supabase.co/functions/v1/whatsapp-webhook";

let sock = null;
let qrCode = null;
let connectionStatus = "disconnected";
let connectedPhone = null;

const logger = pino({ level: "silent" });

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = await QRCode.toDataURL(qr);
      connectionStatus = "disconnected";
      console.log("📱 QR Code gerado - escaneie pelo WhatsApp");
    }

    if (connection === "open") {
      connectionStatus = "connected";
      qrCode = null;
      connectedPhone = sock.user?.id?.split(":")[0] || null;
      console.log("✅ WhatsApp conectado:", connectedPhone);
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      connectedPhone = null;
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconectando...");
        setTimeout(connectWhatsApp, 3000);
      } else {
        console.log("❌ Deslogado. Apague a pasta auth_info e reinicie.");
        if (fs.existsSync("auth_info")) {
          fs.rmSync("auth_info", { recursive: true });
        }
        setTimeout(connectWhatsApp, 5000);
      }
    }
  });

  // ============================================
  // 📩 RECEBER MENSAGENS E CHAMAR O WEBHOOK
  // ============================================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === "status@broadcast") continue;

      // Extrair texto da mensagem
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      if (!text.trim()) continue;

      const phone = jid.replace("@s.whatsapp.net", "");
      const contactName = msg.pushName || "Unknown";

      console.log(`📨 Mensagem de ${contactName} (${phone}): ${text}`);

      // Chamar o webhook do NexusBot
      try {
        const response = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: phone,
            message: text.trim(),
            contact_name: contactName,
          }),
        });

        const data = await response.json();

        // Se o webhook retornou uma resposta, envia pro WhatsApp
        if (data.reply) {
          await sock.sendMessage(jid, { text: data.reply });
          console.log(`🤖 Resposta (${data.mode}): ${data.reply.substring(0, 50)}...`);
        } else {
          console.log(`⏸️ Bot desligado ou sem resposta para: ${text.substring(0, 30)}`);
        }
      } catch (err) {
        console.error("❌ Erro ao chamar webhook:", err.message);
      }
    }
  });
}

// ============================================
// 🌐 ROTAS DA API
// ============================================

// Status do servidor
app.get("/", (req, res) => {
  res.json({
    status: "running",
    whatsapp: connectionStatus,
    phone: connectedPhone,
  });
});

// QR Code
app.get("/api/qr", (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({ status: "connected", phone: connectedPhone });
  }
  if (qrCode) {
    return res.json({ status: "qr", qr: qrCode });
  }
  res.json({ status: "waiting", message: "Aguardando QR Code..." });
});

// Enviar mensagem
app.post("/send", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: "phone e message são obrigatórios" });
    }
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: "Mensagem enviada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Desconectar
app.post("/disconnect", async (req, res) => {
  try {
    if (sock) await sock.logout();
    connectionStatus = "disconnected";
    connectedPhone = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reiniciar
app.post("/restart", async (req, res) => {
  if (fs.existsSync("auth_info")) {
    fs.rmSync("auth_info", { recursive: true });
  }
  connectionStatus = "disconnected";
  connectedPhone = null;
  connectWhatsApp();
  res.json({ success: true, message: "Reiniciando..." });
});

// ============================================
// 🚀 INICIAR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  connectWhatsApp();
});
