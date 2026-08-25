import { fmtDate, fmtDuration, escapeHtml } from "../utils.js";
import { openOverlay, closeOverlay } from "./overlay.js";

const modalEl = document.getElementById("episode-modal");
const bodyEl = document.getElementById("episode-modal-body");

document.getElementById("close-episode-modal").addEventListener("click", closeOverlay);

/**
 * Muestra el popup de "+info" con todos los datos del episodio, incluida
 * la descripción completa. `onAction` recibe (episode, buttonEl) igual que
 * el botón de descarga/subida de las listas, para poder lanzar el mismo
 * flujo directamente desde el popup.
 */
export function openEpisodeModal(episode, onAction, buildActionButton) {
  const badges = [];
  if (episode.isOriginal) badges.push(`<span class="tag-original">iVoox Originals</span>`);
  if (episode.isExclusive) badges.push(`<span class="tag-exclusive">🔒 Exclusivo</span>`);

  const metaBits = [];
  if (episode.date) metaBits.push(escapeHtml(fmtDate(episode.date)));
  if (episode.duration) metaBits.push(escapeHtml(fmtDuration(episode.duration)));

  const description = (episode.description || "").trim();

  bodyEl.innerHTML = `
    ${episode.image ? `<img class="episode-modal-cover" src="${episode.image}" alt="" onerror="this.remove()" />` : ""}
    <div class="episode-modal-content">
      <p class="episode-modal-program">${escapeHtml(episode.program || "")}</p>
      <h2 class="episode-modal-title" id="episode-modal-title">${escapeHtml(episode.title)}</h2>
      ${badges.length ? `<div class="episode-modal-badges">${badges.join("")}</div>` : ""}
      ${metaBits.length ? `<p class="episode-modal-meta">${metaBits.map((b) => `<span>${b}</span>`).join("")}</p>` : ""}
      <div class="episode-modal-description${description ? "" : " is-empty"}">${escapeHtml(description)}</div>
    </div>
    <div class="episode-modal-footer" id="episode-modal-footer"></div>
  `;

  if (onAction && buildActionButton) {
    const btn = buildActionButton(episode, onAction);
    document.getElementById("episode-modal-footer").appendChild(btn);
  }

  openOverlay(modalEl);
}
