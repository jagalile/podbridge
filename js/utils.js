// Pequeñas utilidades compartidas por toda la app.

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function clone(templateId) {
  const tpl = document.getElementById(templateId);
  return tpl.content.firstElementChild.cloneNode(true);
}

export function fmtDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m > 0) return `${m} min`;
  return `${ss} s`;
}

export function fmtDate(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "";
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

/** "hace 3 min" / "hace 2 h" / "hace 5 d" / fecha completa si hace más
 * de una semana — para marcas de tiempo propias (p. ej. la última
 * exportación de datos), no para el texto relativo de iVoox — para eso
 * está parseRelativeDate(), que va al revés (texto → timestamp). */
export function fmtRelativeTime(timestamp) {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < MIN) return "justo ahora";
  if (diff < HOUR) return `hace ${Math.floor(diff / MIN)} min`;
  if (diff < DAY) return `hace ${Math.floor(diff / HOUR)} h`;
  if (diff < 7 * DAY) return `hace ${Math.floor(diff / DAY)} d`;
  return fmtDate(timestamp);
}

export function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const MINUTE_MS = 60_000, HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS, MONTH_MS = 30 * DAY_MS, YEAR_MS = 365 * DAY_MS;

/**
 * Convierte el texto relativo que da iVoox para la fecha de un episodio
 * ("Hoy", "Ayer", "5 días", "2 semanas"...) en un timestamp aproximado.
 * No hay ninguna fecha exacta en el HTML de iVoox, solo este texto — así
 * que esto es necesariamente una aproximación, pensada para poder
 * ordenar episodios de programas distintos por fecha (ver
 * loadFavoriteEpisodes en main.js), no para saber el día exacto.
 * Devuelve 0 (el valor más antiguo posible) si el texto no se reconoce,
 * para que ese episodio caiga al final en vez de romper el orden.
 */
export function parseRelativeDate(text) {
  if (!text) return 0;
  const t = text.trim().toLowerCase();
  if (t === "hoy") return Date.now();
  if (t === "ayer") return Date.now() - DAY_MS;

  const m = t.match(/^(\d+)\s*(minuto|min|hora|h|d[ií]a|semana|mes|a[ñn]o)/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit.startsWith("min")) return Date.now() - n * MINUTE_MS;
  if (unit === "hora" || unit === "h") return Date.now() - n * HOUR_MS;
  if (unit.startsWith("d")) return Date.now() - n * DAY_MS;
  if (unit.startsWith("semana")) return Date.now() - n * WEEK_MS;
  if (unit.startsWith("mes")) return Date.now() - n * MONTH_MS;
  return Date.now() - n * YEAR_MS; // año/anio
}

/**
 * A partir de este tamaño, Cloudflare Workers no consigue mantener
 * fiable la subida saliente hacia Pocket Casts — ver la sección
 * "Episodios muy grandes" del README. Se usa en download.js para decidir
 * si un episodio va por el Worker directamente o por el servicio de
 * relevo externo.
 */
export const LARGE_EPISODE_BYTES = 100 * 1024 * 1024;

// Bitrate mínimo asumido cuando no se conoce el tamaño real (el HEAD del
// Worker a iVoox falló, o la CDN no devolvió Content-Length — pasa sobre
// todo con episodios muy largos). 15 KB/s (~123 kbps) es el extremo bajo
// de lo observado en episodios reales (~50-60 MB/hora). Se usa solo para
// decidir la vía de subida, nunca para lo que se enseña en pantalla —
// mejor pasarse de precavido y mandar por el relevo un episodio que en
// realidad cabía por el Worker, que al revés: intentarlo por el Worker,
// descargarlo entero de iVoox y que la subida falle con un 413 a media
// subida por haber asumido "sin tamaño = pequeño".
const MIN_ASSUMED_BYTES_PER_SECOND = 15 * 1024;

/** true si el episodio hay que mandarlo por el relevo en vez de por el
 * Worker directo — por tamaño conocido, o si no hay tamaño, estimado a
 * partir de la duración (ver MIN_ASSUMED_BYTES_PER_SECOND). */
export function isLargeEpisode(episode) {
  if (episode.sizeBytes) return episode.sizeBytes > LARGE_EPISODE_BYTES;
  if (episode.duration) return episode.duration * MIN_ASSUMED_BYTES_PER_SECOND > LARGE_EPISODE_BYTES;
  return false; // ni tamaño ni duración: no hay con qué estimar, se intenta por la vía normal
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
