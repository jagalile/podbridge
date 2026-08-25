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
 * @returns {Promise<{uuid:string, title:string}>}
 */
export async function uploadFile(fileBlob, meta, token, onProgress) {
  const contentType = meta.contentType || "audio/mpeg";
  const params = { title: meta.title, contentType };
  if (meta.hasImage) params.hasImage = "1";
  return xhrUpload("/pocketcasts/upload", params, fileBlob, contentType, token, onProgress);
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
 */
export async function uploadImage(imageBlob, uuid, token, onProgress) {
  const contentType = imageBlob.type || "image/jpeg";
  return xhrUpload("/pocketcasts/upload-image", { uuid, contentType }, imageBlob, contentType, token, onProgress);
}

// fetch() no expone progreso de subida de forma nativa; usamos XHR para
// poder pintar una barra de progreso real mientras se envía el fichero.
function xhrUpload(path, params, blob, contentType, token, onProgress) {
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
    xhr.send(blob);
  });
}

function resolveBase() {
  // Lectura directa de localStorage (en vez de importar state.js) para
  // evitar un ciclo de módulos; es la misma clave que usa saveProxyUrl().
  return localStorage.getItem("pb.proxyUrl") || "";
}

export { request };
