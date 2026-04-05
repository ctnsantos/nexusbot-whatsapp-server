const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { startWhatsApp } = require('./whatsapp');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Store WhatsApp connection state
let whatsappState = {
  qr: null,
  connected: false,
  phoneNumber: null,
  sock: null
};

// Start WhatsApp connection
startWhatsApp(supabase, whatsappState);

// === API Routes ===

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    whatsapp: whatsappState.connected ? 'connected' : 'disconnected',
    phone: whatsappState.phoneNumber || null
  });
});

// Get QR Code as HTML page
app.get('/qr', (req, res) => {
  if (whatsappState.connected) {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111;color:#0f0;font-family:sans-serif;flex-direction:column">
        <h1>✅ WhatsApp Conectado!</h1>
        <p>Número: ${whatsappState.phoneNumber}</p>
        <a href="/" style="color:#0af">Ver status</a>
      </body></html>
    `);
  }
  if (!whatsappState.qr) {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111;color:#fff;font-family:sans-serif;flex-direction:column">
        <h1>⏳ Aguardando QR Code...</h1>
        <p>Recarregue a página em alguns segundos</p>
        <script>setTimeout(() => location.reload(), 3000)</script>
      </body></html>
    `);
  }
  res.send(`
    <html><body style="display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111;color:#fff;font-family:sans-serif;flex-direction:column">
      <h1>📱 Escaneie o QR Code</h1>
      <p>Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo</p>
      <img src="${whatsappState.qr}" style="width:300px;height:300px;margin:20px;border-radius:12px" />
      <p style="color:#888">O QR Code expira em 60 segundos. A página recarrega automaticamente.</p>
      <script>setTimeout(() => location.reload(), 30000)</script>
    </body></html>
  `);
});

// API endpoint for QR (JSON)
app.get('/api/qr', (req, res) => {
  if (whatsappState.connected) {
    return res.json({ status: 'connected', phone: whatsappState.phoneNumber });
  }
  if (!whatsappState.qr) {
    return res.json({ status: 'waiting', message: 'QR Code ainda não gerado.' });
  }
  res.json({ status: 'qr', qr: whatsappState.qr });
});

// Send message
app.post('/send', async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  if (!whatsappState.connected || !whatsappState.sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    await whatsappState.sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Disconnect
app.post('/disconnect', (req, res) => {
  if (whatsappState.sock) {
    whatsappState.sock.logout();
    whatsappState.connected = false;
    whatsappState.qr = null;
    whatsappState.phoneNumber = null;
    res.json({ success: true, message: 'Disconnected' });
  } else {
    res.json({ success: false, message: 'Not connected' });
  }
});

// Restart connection
app.post('/restart', (req, res) => {
  whatsappState.connected = false;
  whatsappState.qr = null;
  whatsappState.phoneNumber = null;
  startWhatsApp(supabase, whatsappState);
  res.json({ success: true, message: 'Restarting...' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NexusBot WhatsApp Server running on port ${PORT}`);
});
