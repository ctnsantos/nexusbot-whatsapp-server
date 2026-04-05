const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const logger = pino({ level: 'silent' });

async function startWhatsApp(supabase, state) {
  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState('./auth_sessions');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: authState,
      logger,
      printQRInTerminal: true,
      browser: ['NexusBot', 'Chrome', '120.0.0'],
    });

    state.sock = sock;

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('New QR Code generated');
        state.qr = await QRCode.toDataURL(qr);
        state.connected = false;
      }

      if (connection === 'close') {
        state.connected = false;
        state.qr = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log('Connection closed. Status:', statusCode, 'Reconnecting:', shouldReconnect);

        if (shouldReconnect) {
          setTimeout(() => startWhatsApp(supabase, state), 3000);
        } else {
          console.log('Logged out. Scan QR again to reconnect.');
          // Clean auth to force new QR
          const fs = require('fs');
          if (fs.existsSync('./auth_sessions')) {
            fs.rmSync('./auth_sessions', { recursive: true });
          }
          setTimeout(() => startWhatsApp(supabase, state), 3000);
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp connected!');
        state.connected = true;
        state.qr = null;
        state.phoneNumber = sock.user?.id?.split(':')[0] || 'unknown';
        console.log('Phone:', state.phoneNumber);
      }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const from = msg.key.remoteJid;
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';

        if (!text || !from) continue;

        const phoneNumber = from.replace('@s.whatsapp.net', '');
        const pushName = msg.pushName || 'Unknown';

        console.log(`Message from ${pushName} (${phoneNumber}): ${text}`);

        // Save to Supabase
        try {
          await supabase.from('whatsapp_messages').insert({
            phone_number: phoneNumber,
            contact_name: pushName,
            message: text,
            direction: 'incoming',
            jid: from,
          });
        } catch (err) {
          console.error('Error saving message:', err);
        }

        // Auto-reply (customize as needed)
        const reply = generateReply(text);
        if (reply) {
          await sock.sendMessage(from, { text: reply });

          // Save reply to Supabase
          try {
            await supabase.from('whatsapp_messages').insert({
              phone_number: phoneNumber,
              contact_name: 'NexusBot',
              message: reply,
              direction: 'outgoing',
              jid: from,
            });
          } catch (err) {
            console.error('Error saving reply:', err);
          }
        }
      }
    });

  } catch (err) {
    console.error('Error starting WhatsApp:', err);
    setTimeout(() => startWhatsApp(supabase, state), 5000);
  }
}

function generateReply(text) {
  const lower = text.toLowerCase().trim();

  if (['oi', 'olá', 'ola', 'hello', 'hi', 'bom dia', 'boa tarde', 'boa noite'].some(g => lower.includes(g))) {
    return '👋 Olá! Bem-vindo ao NexusBot! Como posso te ajudar?\n\n1️⃣ Informações\n2️⃣ Suporte\n3️⃣ Falar com atendente';
  }

  if (lower === '1' || lower.includes('informaç')) {
    return 'ℹ️ Somos o NexusBot - seu assistente virtual no WhatsApp!\n\nDigite *2* para suporte ou *3* para falar com um atendente.';
  }

  if (lower === '2' || lower.includes('suporte')) {
    return '🔧 Para suporte, descreva seu problema que vamos te ajudar!';
  }

  if (lower === '3' || lower.includes('atendente') || lower.includes('humano')) {
    return '👤 Um atendente será notificado e entrará em contato em breve. Aguarde!';
  }

  return '🤖 Não entendi sua mensagem. Digite *oi* para ver o menu de opções!';
}

module.exports = { startWhatsApp };
