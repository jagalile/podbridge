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
 * Pide al Worker una URL prefirmada para subir el audio de un episodio a
 * Archivos. Esta petición es pequeña (solo metadatos: título, tamaño,
 * tipo) — el audio en sí nunca la atraviesa. La subida real del audio va
 * después, directa del navegador a `uploadUrl` (ver putDirect()).
 *
 * No es una elección de diseño arbitraria: Cloudflare Workers limita a
 * 100 MB el cuerpo de las peticiones HTTP en las que participa — tanto las
 * que recibe como las que él mismo hace hacia fuera — así que ni recibir
 * el audio del navegador ni reenviarlo él mismo a Pocket Casts funciona
 * con episodios largos (uno de ~5h ronda los 260-300 MB). La única forma
 * de mover el fichero sin tropezar con eso es que nunca pase por el Worker
 * en ningún sentido: navegador → iVoox y navegador → Pocket Casts,
 * directos los dos, igual que hace la app oficial (ver README).
 *
 * @param {{title:string, size:number, contentType:string, hasImage?:boolean}} meta
 * @param {string} token
 * @returns {Promise<{uuid:string, uploadUrl:string, contentType:string}>}
 */
export async function requestEpisodeUpload(meta, token) {
  return postJson(
    "/pocketcasts/upload-episode",
    { title: meta.title, size: meta.size, contentType: meta.contentType, hasImage: !!meta.hasImage },
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

/**
 * Sube un blob directo a una URL prefirmada (S3/almacenamiento de Pocket
 * Casts), sin pasar por el Worker — con progreso real vía XHR.
 *
 * @param {string} url la `uploadUrl` que devolvió requestEpisodeUpload()
 * @param {Blob} blob
 * @param {string} contentType
 * @param {(progress:number)=>void} onProgress
 * @param {AbortSignal} [signal]
 */
export function putDirect(url, blob, contentType, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`El almacenamiento de Pocket Casts respondió ${xhr.status} al subir el audio.`));
    };
    // Sin respuesta HTTP en absoluto (xhr.status queda en 0): normalmente
    // un bloqueo de CORS en el bucket de Pocket Casts, o un corte de red.
    xhr.onerror = () => reject(new Error(
      "No se pudo subir el audio directamente al almacenamiento de Pocket Casts (posible bloqueo de CORS o de red).",
    ));
    xhr.onabort = () => reject(signal?.reason ?? new DOMException("Cancelado.", "AbortError"));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

/**
 * Sube la portada de un episodio ya subido. Paso independiente y opcional:
 * si falla, el episodio se queda en Pocket Casts sin portada personalizada,
 * nada más — nunca hace fallar la subida principal.
 *
 * @param {Blob} imageBlob
 * @param {string} uuid el que devolvió requestEpisodeUpload()
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
