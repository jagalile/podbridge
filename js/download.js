// Orquesta el flujo completo por episodio. El audio ya NO pasa por el
// navegador: se sube de servidor a servidor, por una de estas dos vías
// según el tamaño del episodio (ver isLargeEpisode() en utils.js):
//
//   - Episodios normales (hasta ~100 MB): el propio Worker de Cloudflare
//     lo descarga de iVoox y lo sube a Pocket Casts (uploadEpisodeFromIvoox).
//   - Episodios grandes (más de ~100 MB): Cloudflare Workers no consigue
//     mantener fiable una subida saliente tan larga (confirmado con
//     wrangler tail — la propia red de Cloudflare corta la petición, no
//     Pocket Casts ni nuestro código: ver README → "Episodios muy
//     grandes"), así que el Worker solo pide la URL de subida
//     (requestEpisodeUploadInit) y es un servicio aparte, fuera de
//     Cloudflare (relayUpload, ver api/relay.js), quien hace el streaming
//     real de iVoox a Pocket Casts.
//
// El tamaño no siempre se conoce (el Worker lo obtiene con un HEAD a
// iVoox al listar episodios, y a veces falla o la CDN no da
// Content-Length — típico en episodios muy largos, justo los que más
// importa clasificar bien). Sin tamaño, isLargeEpisode() estima a partir
// de la duración en vez de asumir "pequeño" por defecto.
//
// Solo la portada, que siempre es pequeña, se descarga al navegador y se
// sube desde aquí en los dos casos.
//
// Todo queda reflejado en el store (jobs) para que la UI reaccione. Cada
// job tiene su propio AbortController y se vigila su actividad: si pasa
// demasiado tiempo sin ninguna señal de vida, se cancela solo y queda en
// error listo para reintentar — antes un atasco de red se quedaba
// colgado para siempre sin ninguna forma de recuperarlo salvo recargar
// la página entera.

import { state, setJob } from "./state.js";
import { imageProxyUrl } from "./api/ivoox.js";
import { uploadEpisodeFromIvoox, uploadImage, requestEpisodeUploadInit, cancelEpisodeUpload } from "./api/pocketcasts.js";
import { relayUpload } from "./api/relay.js";
import { isLargeEpisode } from "./utils.js";
import { noteJobStarted, noteJobEnded } from "./wakelock.js";

// Reparto del progreso 0..1 mostrado en la UI según haya o no portada que
// subir. La fase "uploadEpisode" (audio de iVoox a Pocket Casts, por
// Worker o por el relevo externo) es una única petición sin progreso en
// bytes real, así que se muestra como indeterminada en vez de fingir un
// porcentaje que no se corresponde con nada — ver job.indeterminate en
// cards.js.
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

// Cada pocos segundos se revisa si algún job lleva demasiado sin dar
// señales de vida — con un cuidado importante: en móvil, apagar la
// pantalla o cambiar de pestaña hace que el navegador pause o retrase
// mucho los timers en segundo plano (para ahorrar batería), así que un
// job que en realidad iba bien puede acumular varios minutos "sin
// actividad" solo porque no ha habido ocasión de comprobarlo — no porque
// se haya atascado de verdad. Sin este cuidado, la primera comprobación
// al volver a primer plano ve ese hueco enorme y cancela el job en
// seco, aunque el audio ya se hubiera subido bien por debajo.
let pageHidden = typeof document !== "undefined" && document.hidden;
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    pageHidden = document.hidden;
    if (!pageHidden) {
      // Al volver, se da a todos los jobs en curso el beneficio de la
      // duda: se resetea su última actividad a "ahora" en vez de dejar
      // que el próximo tick los vea con minutos de retraso acumulado.
      const now = Date.now();
      for (const id of lastActivity.keys()) lastActivity.set(id, now);
    }
  });
}

setInterval(() => {
  if (pageHidden) return; // no evaluar atascos mientras está en segundo plano
  const now = Date.now();
  for (const [id, since] of lastActivity) {
    if (now - since > STALL_TIMEOUT_MS) {
      cancelJob(id, "Sin respuesta durante demasiado tiempo.");
    }
  }
}, 5000);

export async function runEpisodeJob(episode) {
  const id = episode.id;
  const isLarge = isLargeEpisode(episode);

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
  if (isLarge && !state.settings.relayUrl) {
    setJob(id, {
      status: "error",
      error: "Episodio de más de 100 MB: configura el servicio de relevo en Ajustes para poder subirlo (ver README → Episodios muy grandes).",
    });
    return;
  }

  const w = episode.image ? WEIGHTS_WITH_IMAGE : WEIGHTS_NO_IMAGE;
  let base = 0;

  const controller = new AbortController();
  controllers.set(id, controller);
  const { signal } = controller;
  const touch = () => lastActivity.set(id, Date.now());
  touch();
  noteJobStarted(); // mantiene la pantalla encendida mientras haya algo en curso — ver wakelock.js

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
      result = isLarge
        ? await uploadAudioViaRelay(episode, imageBlob, signal)
        : await uploadEpisodeFromIvoox(
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
      } catch {
        // El audio ya está subido en Pocket Casts a estas alturas — pase
        // lo que pase con la portada (fallo real, o un aborto del
        // vigilante de atascos, típico si el móvil apaga la pantalla a
        // media subida y el navegador congela los timers un rato), el
        // episodio sigue siendo un éxito. Antes un aborto aquí sí tiraba
        // todo el job a error aunque el audio llevara rato subido de
        // verdad — no tiene sentido: no hay forma de "deshacer" un
        // audio que ya está en Pocket Casts, así que más vale dejarlo
        // como hecho y como mucho perder la portada.
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
    noteJobEnded();
  }
}

/**
 * Sube el audio de un episodio grande por el servicio de relevo externo
 * (fuera de Cloudflare): primero le pide al Worker una URL de subida ya
 * autorizada (petición pequeña, sin el audio), y luego es el relevo quien
 * hace el streaming real de iVoox a Pocket Casts — el audio no pasa ni
 * por el navegador ni por el Worker en ningún momento.
 *
 * En cuanto requestEpisodeUploadInit() tiene éxito, Pocket Casts YA ha
 * creado un registro para este fichero (con `init.uuid`), aunque el
 * audio en sí todavía no le haya llegado. Si el paso del relevo falla o
 * se cancela a partir de aquí, ese registro se queda huérfano en
 * "Procesando…" para siempre a menos que se borre explícitamente — de
 * ahí el cancelEpisodeUpload() del catch.
 */
async function uploadAudioViaRelay(episode, imageBlob, signal) {
  const init = await requestEpisodeUploadInit(
    episode.downloadUrl,
    { title: episode.title, hasImage: !!imageBlob },
    state.pocketcasts.token,
  );
  try {
    await relayUpload(
      { audioUrl: init.audioUrl, uploadUrl: init.uploadUrl, contentType: init.contentType, size: init.size },
      state.settings.relayUrl,
      state.settings.relaySecret,
      signal,
    );
  } catch (err) {
    await cancelEpisodeUpload(init.uuid, state.pocketcasts.token);
    throw err;
  }
  return { uuid: init.uuid };
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
