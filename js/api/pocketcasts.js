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
 * @param {Blob} fileBlob audio ya descargado
 * @param {{title:string, contentType:string}} meta
 * @param {string} token
 * @param {(progress:number)=>void} onProgress 0..1, solo durante la subida
 */
export async function uploadFile(fileBlob, meta, token, onProgress) {
  const form = new FormData();
  form.append("token", token);
  form.append("title", meta.title);
  form.append("contentType", meta.contentType || "audio/mpeg");
  form.append("file", fileBlob, "episode.mp3");

  // fetch() no expone progreso de subida de forma nativa; usamos XHR para
  // poder pintar una barra de progreso real mientras el Worker retransmite
  // el fichero hacia el almacenamiento de Pocket Casts.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${resolveBase()}/pocketcasts/upload`);
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
    xhr.onerror = () => reject(new Error("No se pudo contactar con el Worker para subir el episodio."));
    xhr.send(form);
  });
}

function resolveBase() {
  // Lectura directa de localStorage (en vez de importar state.js) para
  // evitar un ciclo de módulos; es la misma clave que usa saveProxyUrl().
  return localStorage.getItem("pb.proxyUrl") || "";
}

export { request };
