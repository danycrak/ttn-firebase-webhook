const express = require('express');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(express.json());

// Inicializar Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_ROOT
});

const db = admin.database();

// Función para decodificar payload de 10 bytes
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
    console.log("Webhook recibido de TTN");
    
    const payload = req.body;
    
    // Obtener device_id (collar-a, collar-b, etc)
    const deviceId = payload.end_device_ids?.device_id;
    if (!deviceId) {
      console.log("ERROR: No hay device_id en el payload");
      return res.status(400).json({ error: "No device_id" });
    }

    // Obtener bytes del payload
    const payloadBytes = payload.uplink_message?.frm_payload;
    if (!payloadBytes) {
      console.log("ERROR: No hay payload en el mensaje");
      return res.status(400).json({ error: "No payload" });
    }

    // Convertir base64 a bytes
    const buffer = Buffer.from(payloadBytes, 'base64');
    const bytes = Array.from(buffer);

    console.log(`Device: ${deviceId}, Bytes: ${bytes.join(', ')}`);

    // Decodificar
    const decoded = decodePayload(bytes);
    if (!decoded) {
      console.log("ERROR: No se pudo decodificar el payload");
      return res.status(400).json({ error: "Decode error" });
    }

    console.log(`Decodificado: lat=${decoded.lat}, lng=${decoded.lon}, batt=${decoded.batt}%`);

    // Obtener sessionId activo desde /collares/{deviceId}/current
    const currentRef = db.ref(`collares/${deviceId}/current`);
    const snapshot = await currentRef.once('value');
    const currentData = snapshot.val();

    if (!currentData || !currentData.sessionId) {
      console.log(`AVISO: No hay sesión activa para ${deviceId}`);
      return res.status(200).json({ warning: "No active session" });
    }

    const sessionId = currentData.sessionId;
    console.log(`Sesión activa: ${sessionId}`);

    // Timestamp en milisegundos
    const timestamp = Date.now();

    // Escribir punto en Firebase
    const pointRef = db.ref(`collares/${deviceId}/sessions/${sessionId}/points/${timestamp}`);
    await pointRef.set({
      lat: decoded.lat,
      lng: decoded.lon,
      batt: decoded.batt,
      acc: decoded.acc,
      ts: timestamp
    });

    console.log(`✓ Punto guardado en ${deviceId}/sessions/${sessionId}/points/${timestamp}`);
    res.json({ status: "ok", deviceId, sessionId, timestamp });

  } catch (error) {
    console.error("Error en webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: "ok" });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log(`Webhook en: http://localhost:${PORT}/webhook`);
});
