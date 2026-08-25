// Capa de acceso a iVoox. iVoox no ofrece API JSON pública: el Worker hace
// scraping de sus páginas HTML y nos devuelve JSON ya normalizado con esta
// forma:
//
// Programa:  { id, type:"program", title, author, description, url, image, isOriginal }
// Episodio:  { id, type:"episode", title, program, url, image, isOriginal,
//              isExclusive, duration, date, description, downloadUrl }
//
// downloadUrl es null cuando el episodio es exclusivo (no descargable).
// `image` apunta directo a la CDN de iVoox — para descargarla de verdad
// (p. ej. para subirla como portada a Pocket Casts) hay que pasarla por
// imageProxyUrl(), no hacerle fetch() directo.

import { getJson } from "./proxy.js";

export async function search(query, type, { signal } = {}) {
  const q = encodeURIComponent(query.trim());
  const data = await getJson(`/ivoox/search?q=${q}&type=${type}`, { signal });
  return data.results || [];
}

export async function getProgram(programUrl, { page = 1, signal } = {}) {
  const u = encodeURIComponent(programUrl);
  const data = await getJson(`/ivoox/program?url=${u}&page=${page}`, { signal });
  return {
    info: data.info,
    episodes: data.episodes || [],
    hasMore: !!data.hasMore,
  };
}

/** URL (a través del Worker) desde la que descargar una portada en crudo. */
export function imageProxyUrl(proxyBaseUrl, imageUrl) {
  return `${proxyBaseUrl}/ivoox/image?url=${encodeURIComponent(imageUrl)}`;
}
