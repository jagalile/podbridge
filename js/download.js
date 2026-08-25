// Orquesta el flujo completo por episodio: el navegador descarga el audio
// de iVoox (vía el Worker, que solo añade cabeceras CORS — no hace nada
// con el cuerpo) y lo sube directo a la URL prefirmada que Pocket Casts le
// da para ese fichero. El Worker nunca ve el audio en sí en ningún sentido
// — ni lo recibe ni lo reenvía él mismo — porque Cloudflare Workers limita
// a 100 MB el cuerpo de las peticiones HTTP en las que participa, y un
// episodio de varias horas ronda fácilmente los 200-300 MB. La portada,
// que siempre es pequeña, sí se sube a través del Worker (ver
// pocketcasts.js) sin que eso suponga ningún problema.
//
// Todo queda reflejado en el store (jobs) para que la UI reaccione. Cada
// job tiene su propio AbortController y se vigila su actividad: si pasa
// demasiado tiempo sin ninguna señal de vida, se cancela solo y queda en
// error listo para reintentar — antes un atasco de red se quedaba
// colgado para siempre sin ninguna forma de recuperarlo salvo recargar
// la página entera.

import { state, setJob } from "./state.js";
import { audioProxyUrl, imageProxyUrl } from "./api/ivoox.js";
import { requestEpisodeUpload, putDirect, uploadImage } from "./api/pocketcasts.js";
import { uuid } from "./utils.js";

// Reparto del progreso 0..1 mostrado en la UI según haya o no portada que subir.
const WEIGHTS_WITH_IMAGE = { downloadAudio: 0.35, downloadImage: 0.1, uploadAudio: 0.4, uploadImage: 0.15 };
const WEIGHTS_NO_IMAGE = { downloadAudio: 0.45, downloadImage: 0, uploadAudio: 0.55, uploadImage: 0 };

const STALL_TIMEOUT_MS = 45_000;

const controllers = new Map(); // episodeId -> AbortController
const lastActivity = new Map(); // episodeId -> timestamp de la última señal de vida

/** Cancela un job en marcha (botón de la UI, o el propio vigilante de atascos). */
export function cancelJob(id, message = "Cancelado.") {
  const controller = controllers.get(id);
  if (!controller) return;
  controller.abort(new DOMException(message, "AbortError"));
}

// Cada pocos segundos se revisa si algún job lleva demasiado sin dar señales de vida.
setInterval(() => {
  const now = Date.now();
  for (const [id, since] of lastActivity) {
    if (now - since > STALL_TIMEOUT_MS) {
      cancelJob(id, "Sin respuesta durante demasiado tiempo.");
    }
  }
}, 5000);

export async function runEpisodeJob(episode) {
  const id = episode.id;

  if (episode.isExclusive) {
    setJob(id, { status: "error", error: "Episodio exclusivo: iVoox no permite descargarlo." });
    return;
  }
  if (!episode.downloadUrl) {
    setJob(id, { status: "error", error: "No se ha podido localizar el audio de este episodio." });
    return;
  }
  if (state.pocketcasts.status !== "connected") {
    setJob(id, { status: "error", error: "Conecta tu cuenta de Pocket Casts primero." });
    return;
  }
  if (!state.settings.proxyUrl) {
    setJob(id, { status: "error", error: "Configura la URL del Worker en Ajustes." });
    return;
  }

  const w = episode.image ? WEIGHTS_WITH_IMAGE : WEIGHTS_NO_IMAGE;
  let base = 0;

  const controller = new AbortController();
  controllers.set(id, controller);
  const { signal } = controller;
  const touch = () => lastActivity.set(id, Date.now());
  touch();

  try {
    // El título se guarda en el propio job (no solo en el objeto episode)
    // para que el indicador global de descargas/subidas en curso pueda
    // enseñarlo aunque el usuario navegue a otra búsqueda u otro programa
    // mientras tanto y el episodio deje de estar en las listas cargadas.
    setJob(id, { status: "downloading", progress: 0, error: "", title: episode.title });

    const audioBlob = await downloadBinary(
      audioProxyUrl(state.settings.proxyUrl, episode.downloadUrl),
      (p) => { touch(); setJob(id, { progress: base + p * w.downloadAudio }); },
      signal,
    );
    base += w.downloadAudio;

    // La portada es un extra: si falla su descarga, seguimos sin ella en
    // vez de tirar toda la subida por la borda.
    let imageBlob = null;
    if (episode.image) {
      try {
        imageBlob = await downloadBinary(
          imageProxyUrl(state.settings.proxyUrl, episode.image),
          (p) => { touch(); setJob(id, { progress: base + p * w.downloadImage }); },
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw err; // esto sí debe cortar el job entero
      }
      base += w.downloadImage;
    }

    setJob(id, { status: "uploading", progress: base });
    const { uuid: fileUuid, uploadUrl, contentType } = await requestEpisodeUpload(
      {
        title: episode.title,
        size: audioBlob.size,
        contentType: audioBlob.type || "audio/mpeg",
        hasImage: !!imageBlob,
      },
      state.pocketcasts.token,
    );
    await putDirect(
      uploadUrl,
      audioBlob,
      contentType || audioBlob.type || "audio/mpeg",
      (p) => { touch(); setJob(id, { progress: base + p * w.uploadAudio }); },
      signal,
    );
    base += w.uploadAudio;
    setJob(id, { progress: base });

    if (imageBlob) {
      try {
        await uploadImage(
          imageBlob,
          fileUuid,
          state.pocketcasts.token,
          (p) => { touch(); setJob(id, { progress: base + p * w.uploadImage }); },
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw err; // el episodio ya está subido; si no es un aborto, la portada es solo un extra
      }
    }

    setJob(id, { status: "done", progress: 1 });
  } catch (err) {
    const message = signal.aborted
      ? (signal.reason?.message || "Cancelado.")
      : (err.message || "Ha fallado la descarga o la subida.");
    setJob(id, { status: "error", error: message });
  } finally {
    controllers.delete(id);
    lastActivity.delete(id);
  }
}

async function downloadBinary(url, onProgress, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`iVoox respondió ${res.status} al descargar.`);

  const total = Number(res.headers.get("Content-Length")) || 0;
  const contentType = res.headers.get("Content-Type") || "application/octet-stream";

  if (!res.body || !total) {
    // Sin streaming/longitud conocida: descarga directa, sin progreso fino.
    const blob = await res.blob();
    onProgress(1);
    return blob;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    if (signal.aborted) { reader.cancel().catch(() => {}); throw signal.reason ?? new DOMException("Cancelado.", "AbortError"); }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / total, 1));
  }
  return new Blob(chunks, { type: contentType });
}

export { uuid };
