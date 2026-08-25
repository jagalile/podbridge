// Orquesta el flujo completo por episodio. El audio ya NO pasa por el
// navegador: el propio Worker lo descarga de iVoox y lo sube a Pocket
// Casts de servidor a servidor (ver uploadEpisodeFromIvoox) — Cloudflare
// Workers limita a 100 MB el cuerpo de las peticiones que RECIBE, así que
// reenviar un audio ya descargado (un episodio de ~5h ronda los 260-300
// MB) no podía funcionar. Solo la portada, que siempre es pequeña, se
// sigue descargando al navegador y subiendo desde aquí.
//
// Todo queda reflejado en el store (jobs) para que la UI reaccione. Cada
// job tiene su propio AbortController y se vigila su actividad: si pasa
// demasiado tiempo sin ninguna señal de vida, se cancela solo y queda en
// error listo para reintentar — antes un atasco de red se quedaba
// colgado para siempre sin ninguna forma de recuperarlo salvo recargar
// la página entera.

import { state, setJob } from "./state.js";
import { imageProxyUrl } from "./api/ivoox.js";
import { uploadEpisodeFromIvoox, uploadImage } from "./api/pocketcasts.js";
import { uuid } from "./utils.js";

// Reparto del progreso 0..1 mostrado en la UI según haya o no portada que
// subir. La fase "uploadEpisode" (descarga+subida dentro del Worker) es
// una única petición sin progreso en bytes real, así que se muestra como
// indeterminada en vez de fingir un porcentaje que no se corresponde con
// nada — ver job.indeterminate en cards.js.
const WEIGHTS_WITH_IMAGE = { downloadImage: 0.15, uploadEpisode: 0.7, uploadImage: 0.15 };
const WEIGHTS_NO_IMAGE = { downloadImage: 0, uploadEpisode: 1, uploadImage: 0 };

const STALL_TIMEOUT_MS = 45_000;
// Mientras dura la fase indeterminada no hay progreso real que reportar,
// así que se manda un "aún sigo aquí" cada pocos segundos para que el
// vigilante de atascos no la confunda con un job realmente muerto.
const HEARTBEAT_MS = 10_000;

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
    setJob(id, { status: "downloading", progress: 0, error: "", title: episode.title, indeterminate: false });

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

    setJob(id, { status: "uploading", progress: base, indeterminate: true });
    const heartbeat = setInterval(touch, HEARTBEAT_MS);
    let result;
    try {
      result = await uploadEpisodeFromIvoox(
        episode.downloadUrl,
        { title: episode.title, hasImage: !!imageBlob },
        state.pocketcasts.token,
        signal,
      );
    } finally {
      clearInterval(heartbeat);
    }
    base += w.uploadEpisode;
    setJob(id, { progress: base, indeterminate: false });

    if (imageBlob) {
      try {
        await uploadImage(
          imageBlob,
          result.uuid,
          state.pocketcasts.token,
          (p) => { touch(); setJob(id, { progress: base + p * w.uploadImage }); },
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw err; // el episodio ya está subido; si no es un aborto, la portada es solo un extra
      }
    }

    setJob(id, { status: "done", progress: 1, indeterminate: false });
  } catch (err) {
    const message = signal.aborted
      ? (signal.reason?.message || "Cancelado.")
      : (err.message || "Ha fallado la descarga o la subida.");
    setJob(id, { status: "error", error: message, indeterminate: false });
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
