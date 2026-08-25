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
 * Sube un episodio a Archivos de Pocket Casts.
 *
 * El fichero se envía como cuerpo crudo de la petición (no multipart/
 * FormData): así el Worker puede retransmitirlo a Pocket Casts en
 * streaming, sin tener que cargar el episodio entero en memoria — con
 * FormData no hay más remedio que bufferizarlo, y para episodios largos
 * (varias horas) eso podía agotar la memoria del Worker y dejar la subida
 * colgada sin avisar.
 *
 * @param {Blob} fileBlob audio ya descargado
 * @param {{title:string, contentType:string, hasImage?:boolean}} meta
 * @param {string} token
 * @param {(progress:number)=>void} onProgress 0..1, solo durante la subida
 * @param {AbortSignal} [signal] para poder cancelar (botón de la UI, o el vigilante de atascos)
 * @returns {Promise<{uuid:string, title:string}>}
 */
export async function uploadFile(fileBlob, meta, token, onProgress, signal) {
  const contentType = meta.contentType || "audio/mpeg";
  const params = { title: meta.title, contentType };
  if (meta.hasImage) params.hasImage = "1";
  return xhrUpload("/pocketcasts/upload", params, fileBlob, contentType, token, onProgress, signal);
}

/**
 * Sube la portada de un episodio ya subido. Paso independiente y opcional:
 * si falla, el episodio se queda en Pocket Casts sin portada personalizada,
 * nada más — nunca hace fallar la subida principal.
 *
 * @param {Blob} imageBlob
 * @param {string} uuid el que devolvió uploadFile()
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
