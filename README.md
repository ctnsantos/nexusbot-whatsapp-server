# NexusBot WhatsApp Server

Servidor WhatsApp usando Baileys com conexão via QR Code.

## Variáveis de Ambiente (Render)

| Variável | Valor |
|----------|-------|
| `SUPABASE_URL` | URL do seu projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role Key do Supabase |
| `PORT` | 3000 (padrão do Render) |

## Endpoints

- `GET /` - Status do servidor
- `GET /qr` - QR Code para conectar WhatsApp
- `POST /send` - Enviar mensagem `{ phone, message }`
- `POST /disconnect` - Desconectar WhatsApp
- `POST /restart` - Reconectar WhatsApp

## Deploy no Render

1. Crie um **Web Service** (não Background Worker)
2. Build Command: `npm install`
3. Start Command: `node index.js`
4. Adicione as variáveis de ambiente
