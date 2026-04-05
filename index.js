const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://efnoqbrexeojxccfqsfy.supabase.co/functions/v1/whatsapp-webhook";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const OWNER_USER_ID = process.env.OWNER_USER_ID || "";
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrCode = null;
let connectionStatus = "disconnected";
let connectedPhone = null;
let currentSessionState = "idle";
let lastQrAt = null;
let lastError = null;
let isConnecting = false;
let connectAttempt = 0;
let reconnectTimer = null;

const logger = pino({ level: "silent" });

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function resetRuntimeState() {
  qrCode = null;
  connectedPhone = null;
  connectionStatus = "disconnected";
  currentSessionState = "idle";
}

function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWhatsApp("scheduled-reconnect").catch((error) => {
      console.error("❌ reconnect failed:", error?.message || error);
    });
  }, delayMs);
}

async function destroySocket() {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("messages.upsert");
    if (typeof sock.ws?.close === "function") {
      sock.ws.close();
    }
    if (typeof sock.end === "function") {
      sock.end(new Error("socket reset"));
    }
  } catch (error) {
    console.error("⚠️ error while destroying socket:", error?.message || error);
  } finally {
    sock = null;
  }
}

async function connectWhatsApp(reason = "manual") {
  if (isConnecting) return;

  isConnecting = true;
  connectAttempt += 1;
  lastError = null;
  currentSessionState = "starting";
  qrCode = null;

  try {
    ensureAuthDir();
    await destroySocket();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    console.log("🚀 Starting WhatsApp connection", { reason, connectAttempt, version });

    sock = makeWASocket({
      logger,
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.macOS("Desktop"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      qrTimeout: 45000,
      retryRequestDelayMs: 250,
      emitOwnEvents: false,
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const reasonCode = lastDisconnect?.error?.output?.statusCode;

      if (qr) {
        try {
          qrCode = await QRCode.toDataURL(qr);
          lastQrAt = new Date().toISOString();
          currentSessionState = "qr_ready";
          connectionStatus = "disconnected";
          console.log("📱 QR code generated");
        } catch (error) {
          lastError = `QR generation failed: ${error?.message || error}`;
          console.error("❌ failed to encode QR:", error?.message || error);
        }
      }

      if (connection === "connecting") {
        currentSessionState = qrCode ? "qr_ready" : "connecting";
      }

      if (connection === "open") {
        connectionStatus = "connected";
        currentSessionState = "connected";
        qrCode = null;
        connectedPhone = sock.user?.id?.split(":")[0] || null;
        console.log("✅ WhatsApp connected:", connectedPhone);
      }

      if (connection === "close") {
        connectionStatus = "disconnected";
        connectedPhone = null;
        qrCode = null;
        currentSessionState = "closed";
        lastError = `connection closed (${reasonCode || "unknown"})`;
        console.log("⚠️ connection closed", { reasonCode });

        if (reasonCode === DisconnectReason.loggedOut) {
          console.log("❌ logged out, clearing session");
          try {
            if (fs.existsSync(AUTH_DIR)) {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
          } catch (error) {
            console.error("❌ failed clearing auth dir:", error?.message || error);
          }
          scheduleReconnect(5000);
        } else {
          scheduleReconnect(3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          "";

        if (!text.trim()) continue;

        const phone = jid.replace("@s.whatsapp.net", "");
        const contactName = msg.pushName || "Unknown";

        try {
          const headers = { "Content-Type": "application/json" };
          if (WEBHOOK_SECRET) headers["x-webhook-secret"] = WEBHOOK_SECRET;

          const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({
              phone,
              message: text.trim(),
              contact_name: contactName,
              user_id: OWNER_USER_ID || undefined,
            }),
          });

          const data = await response.json();
          if (data.reply) {
            await sock.sendMessage(jid, { text: data.reply });
          }
        } catch (error) {
          console.error("❌ webhook error:", error?.message || error);
        }
      }
    });
  } catch (error) {
    lastError = error?.message || String(error);
    currentSessionState = "error";
    connectionStatus = "disconnected";
    console.error("❌ connectWhatsApp failed:", lastError);
    scheduleReconnect(5000);
  } finally {
    isConnecting = false;
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "running",
    whatsapp: connectionStatus,
    phone: connectedPhone,
    session_state: currentSessionState,
    qr_ready: Boolean(qrCode),
    last_qr_at: lastQrAt,
    last_error: lastError,
    connect_attempt: connectAttempt,
  });
});

app.get("/api/qr", (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({ status: "connected", phone: connectedPhone });
  }

  if (qrCode) {
    return res.json({ status: "qr", qr: qrCode, message: "QR Code pronto para escanear." });
  }

  return res.json({
    status: currentSessionState === "starting" || currentSessionState === "connecting" ? "loading" : "waiting",
    message: lastError || `Aguardando QR Code... estado=${currentSessionState}`,
  });
});

app.post("/send", async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ error: "phone e message são obrigatórios" });
    }
    if (!sock || connectionStatus !== "connected") {
      return res.status(409).json({ error: "WhatsApp não está conectado" });
    }
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Erro ao enviar mensagem" });
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    await destroySocket();
    resetRuntimeState();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Erro ao desconectar" });
  }
});

app.post("/restart", async (req, res) => {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    await destroySocket();
    resetRuntimeState();
    connectWhatsApp("restart").catch((error) => {
      console.error("❌ restart connect failed:", error?.message || error);
    });
    res.json({ success: true, message: "Reiniciando sessão do WhatsApp..." });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Erro ao reiniciar" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  connectWhatsApp("startup").catch((error) => {
    console.error("❌ startup connect failed:", error?.message || error);
  });
});
