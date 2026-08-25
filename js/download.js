// Orquesta el flujo completo por episodio: descarga desde iVoox (a través
// del Worker, que gestiona cabeceras/hotlink) → sube a Archivos de Pocket
// Casts. Todo queda reflejado en el store (jobs) para que la UI reaccione.

import { state, setJob } from "./state.js";
import { audioProxyUrl } from "./api/ivoox.js";
import { uploadFile } from "./api/pocketcasts.js";
import { uuid } from "./utils.js";

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

  try {
    setJob(id, { status: "downloading", progress: 0, error: "" });
    const blob = await downloadAudio(episode, (p) => setJob(id, { progress: p * 0.5 }));

    setJob(id, { status: "uploading", progress: 0.5 });
    await uploadFile(
      blob,
      { title: episode.title, contentType: blob.type || "audio/mpeg" },
      state.pocketcasts.token,
      (p) => setJob(id, { progress: 0.5 + p * 0.5 }),
    );

    setJob(id, { status: "done", progress: 1 });
  } catch (err) {
    setJob(id, { status: "error", error: err.message || "Ha fallado la descarga o la subida." });
  }
}

async function downloadAudio(episode, onProgress) {
  const url = audioProxyUrl(state.settings.proxyUrl, episode.downloadUrl);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iVoox respondió ${res.status} al descargar el audio.`);

  const total = Number(res.headers.get("Content-Length")) || 0;
  const contentType = res.headers.get("Content-Type") || "audio/mpeg";

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
