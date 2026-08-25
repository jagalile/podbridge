// Cliente de Pocket Casts contra el Worker puente, que es quien realmente
// habla con api.pocketcasts.com (login + subida a Archivos vía protobuf).

import { postJson, request, ProxyRequestError } from "./proxy.js";

export async function login(email, password) {
  try {
    const data = await postJson("/pocketcasts/login", { email, password });
    if (!data.token) throw new Error("Pocket Casts no devolvió un token de sesión.");
    return data.token;
  } catch (err) {
    if (err instanceof ProxyRequestError && err.status === 401) {
      throw new Error("Email o contraseña incorrectos.");
    }
    throw err;
  }
}

/** Espacio usado/disponible en Archivos de Pocket Casts, en bytes. */
export async function getUsage(token) {
  const res = await request("/pocketcasts/usage", { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

/**
 * Sube un episodio a Archivos de Pocket Casts, de servidor a servidor: el
 * propio Worker lo descarga de iVoox y lo sube, este fetch solo manda la
 * URL del episodio y el título — nunca el audio en sí.
 *
 * No es una elección de diseño arbitraria: Cloudflare Workers tiene un
 * límite de 100 MB en el cuerpo de las peticiones que RECIBE (ver README
 * → "Cómo funciona el Worker por dentro"), así que reenviar el audio ya
 * descargado desde el navegador no podía funcionar con episodios largos
 * (uno de ~5h ronda los 260-300 MB). Al no pasar por el navegador,
 * tampoco hay progreso en bytes real que mostrar durante esta fase — se
 * trata como indeterminada en la UI (ver download.js).
 *
 * @param {string} episodeUrl
 * @param {{title:string, hasImage?:boolean}} meta
 * @param {string} token
 * @param {AbortSignal} [signal] para poder cancelar (botón de la UI, o el vigilante de atascos)
 * @returns {Promise<{uuid:string, title:string}>}
 */
export async function uploadEpisodeFromIvoox(episodeUrl, meta, token, signal) {
  return postJson(
    "/pocketcasts/upload-episode",
    { episodeUrl, title: meta.title, hasImage: !!meta.hasImage },
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
}

/**
 * Igual que uploadEpisodeFromIvoox(), pero para episodios grandes: el
 * Worker NO descarga ni sube el audio (Cloudflare no consigue mantener
 * fiable esa subida saliente con ficheros de varios cientos de MB — ver
 * README → "Episodios muy grandes"). Se limita a resolver la URL real del
 * mp3, consultar su tamaño y pedirle a Pocket Casts una URL de subida ya
 * autorizada, y devuelve todo eso para que sea el servicio de relevo
 * externo (ver api/relay.js) quien haga el streaming de verdad.
 *
 * @param {string} episodeUrl
 * @param {{title:string, hasImage?:boolean}} meta
 * @param {string} token
 * @returns {Promise<{uuid:string, uploadUrl:string, audioUrl:string, contentType:string, size:number}>}
 */
export async function requestEpisodeUploadInit(episodeUrl, meta, token) {
  return postJson(
    "/pocketcasts/upload-episode-init",
    { episodeUrl, title: meta.title, hasImage: !!meta.hasImage },
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

/**
 * Sube la portada de un episodio ya subido. Paso independiente y opcional:
 * si falla, el episodio se queda en Pocket Casts sin portada personalizada,
 * nada más — nunca hace fallar la subida principal.
 *
 * @param {Blob} imageBlob
 * @param {string} uuid el que devolvió uploadEpisodeFromIvoox()
 * @param {string} token
 * @param {(progress:number)=>void} onProgress
 * @param {AbortSignal} [signal]
 */
export async function uploadImage(imageBlob, uuid, token, onProgress, signal) {
  const contentType = imageBlob.type || "image/jpeg";
  return xhrUpload("/pocketcasts/upload-image", { uuid, contentType }, imageBlob, contentType, token, onProgress, signal);
}

// fetch() no expone progreso de subida de forma nativa; usamos XHR para
// poder pintar una barra de progreso real mientras se envía el fichero.
// XHR no acepta un AbortSignal directamente (a diferencia de fetch), así
// que si llega uno se engancha a mano para poder cancelar desde fuera.
function xhrUpload(path, params, blob, contentType, token, onProgress, signal) {
  const query = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${resolveBase()}${path}?${query}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { resolve({}); }
      } else {
        let message = `Pocket Casts respondió ${xhr.status}`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* ignore */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("No se pudo contactar con el Worker."));
    xhr.onabort = () => reject(signal?.reason ?? new DOMException("Cancelado.", "AbortError"));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

function resolveBase() {
  // Lectura directa de localStorage (en vez de importar state.js) para
  // evitar un ciclo de módulos; es la misma clave que usa saveProxyUrl().
  return localStorage.getItem("pb.proxyUrl") || "";
}

export { request };
