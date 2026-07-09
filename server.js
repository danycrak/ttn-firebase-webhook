const express = require('express');
require('dotenv').config();

const app = express();
app.use(express.json());

// Node 18+ tiene fetch nativo, no necesita node-fetch

// Configuración Firebase
const FB_API_KEY = process.env.FB_API_KEY || "AIzaSyCn0pS5Oa5_-cwb4OVaTHEDSKwQxOv5YpM";
const FB_EMAIL = process.env.FB_EMAIL || "adrian3@gmail.com";
const FB_PASSWORD = process.env.FB_PASSWORD || "12345678";
const FB_DB_ROOT = process.env.FB_DB_ROOT || "https://localizadormascotas-68cd5-default-rtdb.firebaseio.com";

let idToken = null;
let tokenExpireTime = 0;

// Obtener token Firebase
async function getFirebaseToken() {
  if (idToken && Date.now() < tokenExpireTime) {
    return idToken;
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: FB_EMAIL,
          password: FB_PASSWORD,
          returnSecureToken: true
        })
      }
    );

    const data = await response.json();
    if (!data.idToken) {
      throw new Error('No token received');
    }

    idToken = data.idToken;
    tokenExpireTime = Date.now() + (55 * 60 * 1000); // 55 minutos
    console.log("✓ Firebase token obtenido");
    return idToken;
  } catch (error) {
    console.error("ERROR obteniendo token Firebase:", error.message);
    throw error;
  }
}

// Decodificar payload de 10 bytes
function decodePayload(bytes) {
  if (bytes.length < 10) {
    console.log("Payload muy corto:", bytes.length);
    return null;
  }

  // Bytes 0-3: lat int32 big-endian
  const latE6 = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const lat = latE6 / 1000000.0;

  // Bytes 4-7: lon int32 big-endian
  const lonE6 = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  const lon = lonE6 / 1000000.0;

  // Byte 8: batt %
  const batt = bytes[8];

  // Byte 9: acc
  const acc = bytes[9];

  return { lat, lon, batt, acc };
}

// Webhook de TTN
app.post('/webhook', async (req, res) => {
  try {
    console.log("\n=== Webhook TTN recibido ===");
    
    const payload = req.body;
    
    // Obtener device_id
    const deviceId = payload.end_device_ids?.device_id;
    if (!deviceId) {
      console.log("ERROR: No device_id");
      return res.status(400).json({ error: "No device_id" });
    }

    // Obtener payload bytes en base64
    const payloadBase64 = payload.uplink_message?.frm_payload;
    if (!payloadBase64) {
      console.log("ERROR: No hay payload");
      return res.status(400).json({ error: "No payload" });
    }

    // Convertir base64 a bytes
    const buffer = Buffer.from(payloadBase64, 'base64');
    const bytes = Array.from(buffer);
    console.log(`Device: ${deviceId}, Bytes: [${bytes.join(', ')}]`);

    // Decodificar
    const decoded = decodePayload(bytes);
    if (!decoded) {
      console.log("ERROR: No se pudo decodificar");
      return res.status(400).json({ error: "Decode error" });
    }

    console.log(`Decodificado: lat=${decoded.lat.toFixed(6)}, lng=${decoded.lon.toFixed(6)}, batt=${decoded.batt}%`);

    // Obtener token
    const token = await getFirebaseToken();

    // Obtener sessionId activo
    const currentUrl = `${FB_DB_ROOT}/collares/${deviceId}/current.json?auth=${token}`;
    const currentResponse = await fetch(currentUrl);
    const currentData = await currentResponse.json();

    if (!currentData || !currentData.sessionId) {
      console.log(`AVISO: No hay sesión activa para ${deviceId}`);
      return res.status(200).json({ warning: "No active session", deviceId });
    }

    const sessionId = currentData.sessionId;
    console.log(`Sesión activa: ${sessionId}`);

    // Timestamp
    const timestamp = Date.now();

    // Escribir punto en Firebase
    const pointUrl = `${FB_DB_ROOT}/collares/${deviceId}/sessions/${sessionId}/points/${timestamp}.json?auth=${token}`;
    const pointResponse = await fetch(pointUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: decoded.lat,
        lng: decoded.lon,
        batt: decoded.batt,
        acc: decoded.acc,
        ts: timestamp
      })
    });

    if (!pointResponse.ok) {
      throw new Error(`Firebase write failed: ${pointResponse.status}`);
    }

    console.log(`✓ Punto guardado`);
    res.json({ status: "ok", deviceId, sessionId });

  } catch (error) {
    console.error("ERROR:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`📍 Webhook: POST http://localhost:${PORT}/webhook`);
  console.log(`❤️  Health: GET http://localhost:${PORT}/health\n`);
});
