// Orquesta el flujo completo por episodio: descarga el audio (y su
// portada, si tiene) desde iVoox a través del Worker → sube ambos a
// Archivos de Pocket Casts. Todo queda reflejado en el store (jobs) para
// que la UI reaccione.

import { state, setJob } from "./state.js";
import { audioProxyUrl, imageProxyUrl } from "./api/ivoox.js";
import { uploadFile, uploadImage } from "./api/pocketcasts.js";
import { uuid } from "./utils.js";

// Reparto del progreso 0..1 mostrado en la UI según haya o no portada que
// subir (la portada es opcional y no debe hacer más lento el caso normal).
const WEIGHTS_WITH_IMAGE = { downloadAudio: 0.35, downloadImage: 0.1, uploadAudio: 0.4, uploadImage: 0.15 };
const WEIGHTS_NO_IMAGE = { downloadAudio: 0.5, downloadImage: 0, uploadAudio: 0.5, uploadImage: 0 };

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

  try {
    // El título se guarda en el propio job (no solo en el objeto episode)
    // para que el indicador global de descargas/subidas en curso pueda
    // enseñarlo aunque el usuario navegue a otra búsqueda u otro programa
    // mientras tanto y el episodio deje de estar en las listas cargadas.
    setJob(id, { status: "downloading", progress: 0, error: "", title: episode.title });
    const audioBlob = await downloadBinary(
      audioProxyUrl(state.settings.proxyUrl, episode.downloadUrl),
      (p) => setJob(id, { progress: base + p * w.downloadAudio }),
    );
    base += w.downloadAudio;

    // La portada es un extra: si falla su descarga, seguimos sin ella en
    // vez de tirar toda la subida por la borda.
    let imageBlob = null;
    if (episode.image) {
      try {
        imageBlob = await downloadBinary(
          imageProxyUrl(state.settings.proxyUrl, episode.image),
          (p) => setJob(id, { progress: base + p * w.downloadImage }),
        );
      } catch { /* sin portada, no pasa nada */ }
      base += w.downloadImage;
    }

    setJob(id, { status: "uploading", progress: base });
    const result = await uploadFile(
      audioBlob,
      { title: episode.title, contentType: audioBlob.type || "audio/mpeg", hasImage: !!imageBlob },
      state.pocketcasts.token,
      (p) => setJob(id, { progress: base + p * w.uploadAudio }),
    );
    base += w.uploadAudio;

    if (imageBlob) {
      setJob(id, { progress: base });
      try {
        await uploadImage(
          imageBlob,
          result.uuid,
          state.pocketcasts.token,
          (p) => setJob(id, { progress: base + p * w.uploadImage }),
        );
      } catch { /* el episodio ya está subido; la portada es solo un extra */ }
    }

    setJob(id, { status: "done", progress: 1 });
  } catch (err) {
    setJob(id, { status: "error", error: err.message || "Ha fallado la descarga o la subida." });
  }
}

async function downloadBinary(url, onProgress) {
  const res = await fetch(url);
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
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / total, 1));
  }
  return new Blob(chunks, { type: contentType });
}

export { uuid };
