// Renderizado de tarjetas: programa (resultado de búsqueda), episodio
// (resultado de búsqueda) y fila de episodio (dentro de un programa).
// Todas comparten el botón de acción de descarga/subida.

import { clone, fmtDuration, fmtDate, fmtBytes, escapeHtml } from "../utils.js";
import { getJob, isFavorite, toggleFavorite } from "../state.js";
import { cancelJob } from "../download.js";

const FALLBACK_COVER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23e3e1db'/%3E%3Ctext x='50' y='58' font-size='40' text-anchor='middle'%3E%F0%9F%8E%99%EF%B8%8F%3C/text%3E%3C/svg%3E";

export function renderProgramCard(program, onOpen) {
  const node = clone("tpl-program-card");
  const img = node.querySelector("img");
  img.src = program.image || FALLBACK_COVER;
  img.alt = program.title;
  img.onerror = () => { img.src = FALLBACK_COVER; };

  if (program.isOriginal) node.querySelector(".program-badges").hidden = false;

  node.querySelector(".program-title").textContent = program.title;
  node.querySelector(".program-author").textContent = program.author || "";
  node.querySelector(".program-card-open").addEventListener("click", () => onOpen(program));

  const favBtn = node.querySelector(".favorite-btn");
  syncFavoriteButton(favBtn, program.id);
  favBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(program);
    syncFavoriteButton(favBtn, program.id);
  });

  return node;
}

function syncFavoriteButton(btn, programId) {
  const fav = isFavorite(programId);
  btn.classList.toggle("is-favorite", fav);
  btn.setAttribute("aria-label", fav ? "Quitar de favoritos" : "Añadir a favoritos");
  btn.title = fav ? "Quitar de favoritos" : "Añadir a favoritos";
}

export function renderEpisodeCard(episode, onAction, onInfo) {
  const node = clone("tpl-episode-card");
  const img = node.querySelector("img");
  img.src = episode.image || FALLBACK_COVER;
  img.alt = episode.title;
  img.onerror = () => { img.src = FALLBACK_COVER; };

  node.querySelector(".episode-program").textContent = episode.program || "";
  node.querySelector(".episode-title").textContent = episode.title;
  node.querySelector(".episode-title").title = episode.title;
  node.querySelector(".episode-meta").innerHTML = metaHtml(episode);
  const actions = node.querySelector(".episode-actions");
  if (onInfo) actions.appendChild(infoButton(episode, onInfo));
  actions.appendChild(actionButton(episode, onAction));
  return node;
}

export function renderEpisodeRow(episode, onAction, onInfo) {
  const node = clone("tpl-episode-row");
  const img = node.querySelector("img");
  img.src = episode.image || FALLBACK_COVER;
  img.alt = episode.title;
  img.onerror = () => { img.src = FALLBACK_COVER; };

  node.querySelector(".episode-title").textContent = episode.title;
  node.querySelector(".episode-meta").innerHTML = metaHtml(episode);
  const actions = node.querySelector(".episode-actions");
  if (onInfo) actions.appendChild(infoButton(episode, onInfo));
  actions.appendChild(actionButton(episode, onAction));
  return node;
}

const INFO_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none"/></svg>`;

function infoButton(episode, onInfo) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "info-btn";
  btn.title = "Más información";
  btn.setAttribute("aria-label", "Más información sobre este episodio");
  btn.innerHTML = INFO_ICON_SVG;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onInfo(episode);
  });
  return btn;
}

function metaHtml(episode) {
  const bits = [];
  if (episode.date) bits.push(escapeHtml(fmtDate(episode.date)));
  if (episode.duration) bits.push(escapeHtml(fmtDuration(episode.duration)));
  if (episode.sizeBytes) bits.push(escapeHtml(fmtBytes(episode.sizeBytes)));
  let html = bits.map((b) => `<span>${b}</span>`).join(" · ");
  if (episode.isOriginal) html += ` <span class="tag-original">Originals</span>`;
  if (episode.isExclusive) html += ` <span class="tag-exclusive">🔒 Exclusivo</span>`;
  return html;
}

export function actionButton(episode, onAction) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "action-btn";
  btn.dataset.episodeId = episode.id;
  applyJobState(btn, episode);
  btn.addEventListener("click", () => {
    if (btn.classList.contains("is-locked")) return;
    // Con una descarga/subida en marcha, pulsar el botón la cancela en
    // vez de no hacer nada — antes, si algo se quedaba atascado, la
    // única forma de recuperarlo era recargar la página entera.
    if (btn.classList.contains("is-working")) {
      cancelJob(episode.id, "Cancelado por el usuario.");
      return;
    }
    onAction(episode, btn);
  });
  return btn;
}

/** Sincroniza el aspecto de un botón de acción con el job actual (id = episode.id). */
export function applyJobState(btn, episode) {
  const job = getJob(episode.id);

  if (episode.isExclusive) {
    btn.className = "action-btn is-locked";
    btn.disabled = true;
    btn.innerHTML = `🔒 Exclusivo`;
    return;
  }
  if (!episode.downloadUrl) {
    btn.className = "action-btn is-locked";
    btn.disabled = true;
    btn.innerHTML = `— No disponible`;
    btn.title = "No hemos podido localizar el audio descargable de este episodio.";
    return;
  }

  btn.disabled = false;
  switch (job.status) {
    case "downloading":
      btn.className = "action-btn is-working";
      btn.innerHTML = `<span class="spinner"></span> Descargando… ${Math.round(job.progress * 100)}%`;
      btn.title = "Pulsa para cancelar";
      break;
    case "uploading":
      btn.className = "action-btn is-working";
      // La fase de subida real (audio de iVoox a Pocket Casts) pasa
      // entera por el Worker, sin progreso en bytes real que mostrar —
      // mejor decirlo así que fingir un porcentaje que no avanza.
      btn.innerHTML = job.indeterminate
        ? `<span class="spinner"></span> Subiendo el audio…`
        : `<span class="spinner"></span> Subiendo… ${Math.round(job.progress * 100)}%`;
      btn.title = "Pulsa para cancelar";
      break;
    case "done":
      btn.className = "action-btn is-done";
      btn.innerHTML = `✓ En Pocket Casts`;
      break;
    case "error":
      btn.className = "action-btn is-error";
      btn.innerHTML = `⚠️ Reintentar`;
      btn.title = job.error || "";
      break;
    default:
      btn.className = "action-btn";
      btn.innerHTML = `⬇️ Descargar y subir`;
  }
}
