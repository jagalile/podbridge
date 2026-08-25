/**
 * PodBridge — servicio de relevo para episodios grandes.
 *
 * Hace exactamente una cosa: descargar un mp3 de iVoox y subirlo a una
 * URL de Pocket Casts ya autorizada (una URL de subida pre-firmada,
 * ligada a un fichero concreto y pensada para usarse una sola vez),
 * retransmitiendo en streaming directo de un sitio a otro sin guardar
 * nada en disco ni bufferizarlo entero en memoria.
 *
 * Por qué existe esto fuera del Worker de Cloudflare: con episodios de
 * varias horas (~250-300 MB) la subida saliente desde un Cloudflare
 * Worker no es fiable — confirmado en producción con `wrangler tail`, la
 * propia red de Cloudflare corta la petición con un 413 sintético
 * (cabeceras `server: cloudflare` y `cf-ray`, nunca llega a Pocket Casts)
 * antes de que termine de mandarse, pase lo que pase con cómo se
 * construya el streaming del lado del Worker. Un proceso Node normal, en
 * una plataforma con un servidor HTTP real detrás (no una función de
 * borde con límites de tamaño de petición), no tiene ese problema. Ver
 * la sección "Episodios muy grandes" del README principal.
 *
 * Qué NO ve nunca este servicio: el email, la contraseña ni el token de
 * sesión de Pocket Casts. El Worker sigue siendo el único que habla con
 * la API de Pocket Casts para conseguir la URL de subida — a este
 * servicio solo le llega esa URL ya lista (y la del mp3 público de
 * iVoox), lo mínimo posible para hacer su trabajo.
 *
 * Despliegue: pensado para Render.com (Web Service, sin build command,
 * start command `npm start`) — ver el README de esta carpeta. No tiene
 * dependencias de npm; solo usa lo que trae Node 18+.
 */

import http from "node:http";

const PORT = process.env.PORT || 3000;
const RELAY_SECRET = process.env.RELAY_SECRET || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
// 15 min: de sobra incluso para un episodio muy largo en una conexión lenta.
const FETCH_TIMEOUT_MS = 15 * 60 * 1000;

if (!RELAY_SECRET) {
  console.warn(
    "AVISO: RELAY_SECRET no está configurado — este servicio aceptará peticiones de cualquiera. " +
    "Ponle un valor en las variables de entorno antes de usarlo de verdad.",
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Relay-Secret",
    "Access-Control-Max-Age": "86400",
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // Esta petición es solo metadatos (URLs, tamaño, tipo) — nunca
      // debería acercarse a esto. Si pasa, algo va mal o alguien está
      // abusando del endpoint.
      if (size > 1_000_000) { req.destroy(); reject(new Error("Cuerpo demasiado grande para ser una petición de metadatos")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

async function handleRelayUpload(req, res) {
  if (!RELAY_SECRET || req.headers["x-relay-secret"] !== RELAY_SECRET) {
    sendJson(res, 401, { error: "Secreto de relevo incorrecto o no configurado" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: `JSON inválido: ${err.message}` });
    return;
  }

  const { audioUrl, uploadUrl, contentType, size } = body;
  if (!audioUrl || !uploadUrl || !size) {
    sendJson(res, 400, { error: "Faltan audioUrl, uploadUrl o size" });
    return;
  }

  // Validación mínima para que esto no se pueda usar como un proxy
  // genérico hacia cualquier URL: el origen del audio tiene que ser
  // iVoox, y el destino tiene que ser https.
  let audioHost, uploadProtocol;
  try {
    audioHost = new URL(audioUrl).hostname;
    uploadProtocol = new URL(uploadUrl).protocol;
  } catch {
    sendJson(res, 400, { error: "audioUrl o uploadUrl no son URLs válidas" });
    return;
  }
  if (!/(^|\.)ivoox\.com$/.test(audioHost)) {
    sendJson(res, 400, { error: "audioUrl debe ser un dominio de ivoox.com" });
    return;
  }
  if (uploadProtocol !== "https:") {
    sendJson(res, 400, { error: "uploadUrl debe ser https" });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Tiempo de espera agotado")), FETCH_TIMEOUT_MS);

  try {
    console.log(`relay-upload: descargando ${audioUrl}`);
    const audioRes = await fetch(audioUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://www.ivoox.com/",
      },
      signal: controller.signal,
    });
    if (!audioRes.ok || !audioRes.body) {
      sendJson(res, 502, { error: `iVoox respondió ${audioRes.status} al descargar el audio` });
      return;
    }
    console.log(`relay-upload: iVoox Ok, empezando el PUT (${(size / 1e6).toFixed(1)} MB declarados)`);

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType || "audio/mpeg", "Content-Length": String(size) },
      body: audioRes.body,
      duplex: "half",
      signal: controller.signal,
    });

    if (!putRes.ok) {
      const text = await putRes.text().catch(() => "");
      console.error(`relay-upload: Pocket Casts respondió ${putRes.status} — ${text.slice(0, 300)}`);
      sendJson(res, 502, {
        error: `Falló la subida del audio al almacenamiento de Pocket Casts (${putRes.status})`,
        debug: { status: putRes.status, bodySnippet: text.slice(0, 400) },
      });
      return;
    }

    console.log("relay-upload: terminado Ok");
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(`relay-upload: excepción — ${err.message || err}`);
    sendJson(res, 502, { error: err.message || "Fallo al retransmitir el audio" });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, name: "podbridge-relay" });
    return;
  }
  if (req.method === "POST" && req.url === "/relay-upload") {
    handleRelayUpload(req, res);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`podbridge-relay escuchando en :${PORT}`);
});
