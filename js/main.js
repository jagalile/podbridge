import {
  state, subscribe, saveProxyUrl, setWorkerStatus, setPocketCasts, logoutPocketCasts, getJob,
  isFavorite, toggleFavorite, recordUpload,
  rememberMeSupported, persistPocketCastsSession, restorePersistedPocketCastsSession, clearPersistedPocketCastsSession,
} from "./state.js";
import * as ivoox from "./api/ivoox.js";
import * as pocketcasts from "./api/pocketcasts.js";
import { pingWorker } from "./api/proxy.js";
import { runEpisodeJob } from "./download.js";
import { toast } from "./components/toast.js";
import { skeletonGrid, idleState, emptyState, emptyFavoritesState, errorState, proxyMissingState } from "./components/states.js";
import { renderProgramCard, renderEpisodeCard, renderEpisodeRow, applyJobState, actionButton } from "./components/cards.js";
import { openOverlay, closeOverlay } from "./components/overlay.js";
import { openEpisodeModal } from "./components/episodeModal.js";
import { debounce, escapeHtml } from "./utils.js";

const $ = (sel) => document.querySelector(sel);

const resultsEl = $("#results");
const heroEl = $(".hero");
const programViewEl = $("#program-view");
const programHeaderEl = $("#program-header");
const programEpisodesEl = $("#program-episodes");
const episodeFilterEl = $("#program-episode-filter");

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
const settingsPanel = $("#settings-panel");

function openSettings() {
  $("#proxy-url").value = state.settings.proxyUrl;
  openOverlay(settingsPanel);
}
function closeSettings() {
  closeOverlay();
}
$("#open-settings").addEventListener("click", openSettings);
$("#pc-status-btn").addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", closeSettings);

$("#save-proxy").addEventListener("click", () => {
  const value = $("#proxy-url").value;
  if (value && !/^https?:\/\//.test(value)) {
    toast("La URL del Worker debe empezar por https://", "error");
    return;
  }
  saveProxyUrl(value);
  const status = $("#proxy-status");
  status.textContent = value ? "Guardado ✓" : "";
  setTimeout(() => { status.textContent = ""; }, 2500);
  render();
  checkWorker();
});

/** Comprueba si el Worker configurado responde (GET /health). */
async function checkWorker() {
  if (!state.settings.proxyUrl) { setWorkerStatus("unknown"); return; }
  setWorkerStatus("checking");
  const ok = await pingWorker(state.settings.proxyUrl);
  setWorkerStatus(ok ? "ok" : "error");
}
checkWorker();

$("#pc-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.settings.proxyUrl) {
    toast("Configura primero la URL del Worker.", "error");
    return;
  }
  const email = $("#pc-email").value.trim();
  const password = $("#pc-password").value;
  const remember = $("#pc-remember").checked;
  const errorEl = $("#pc-login-error");
  errorEl.hidden = true;

  setPocketCasts({ status: "connecting", error: "" });
  render();
  try {
    const token = await pocketcasts.login(email, password);
    setPocketCasts({ status: "connected", email, token, error: "", remember });
    $("#pc-password").value = "";
    $("#pc-remember").checked = false;
    await persistPocketCastsSession(remember, email, token);
    toast(remember ? "Conectado a Pocket Casts (sesión recordada en este dispositivo)" : "Conectado a Pocket Casts", "success");
  } catch (err) {
    setPocketCasts({ status: "error", error: err.message });
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
  render();
});

$("#pc-logout-btn").addEventListener("click", () => {
  logoutPocketCasts();
  toast("Sesión de Pocket Casts cerrada", "info");
  render();
});

$("#pc-forget-btn").addEventListener("click", () => {
  clearPersistedPocketCastsSession();
  setPocketCasts({ remember: false });
  toast("Este dispositivo ya no recordará la sesión de Pocket Casts", "info");
  render();
});

// Restaura la sesión de Pocket Casts si el usuario activó "recordarme" en
// una visita anterior (token cifrado en localStorage, ver state.js).
restorePersistedPocketCastsSession().then(render);

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
const searchForm = $("#search-form");
const searchInput = $("#search-input");

const searchSubmitBtn = searchForm.querySelector("button[type=submit]");
const searchInputWrap = $(".search-input-wrap");

document.querySelectorAll(".search-type .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".search-type .chip").forEach((c) => {
      c.classList.remove("is-active");
      c.setAttribute("aria-selected", "false");
    });
    chip.classList.add("is-active");
    chip.setAttribute("aria-selected", "true");
    state.search.type = chip.dataset.type;

    const isFavoritesTab = state.search.type === "favorites";
    searchInputWrap.hidden = isFavoritesTab;
    searchSubmitBtn.hidden = isFavoritesTab;

    if (isFavoritesTab) {
      renderFavorites();
    } else if (state.search.query) {
      doSearch();
    }
  });
});

function renderFavorites() {
  closeProgramView();
  if (state.favorites.length === 0) {
    emptyFavoritesState(resultsEl);
    return;
  }
  resultsEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "grid";
  for (const program of state.favorites) {
    wrap.appendChild(renderProgramCard(program, openProgram));
  }
  resultsEl.appendChild(wrap);
}

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  state.search.query = searchInput.value.trim();
  doSearch();
});

const debouncedTypeahead = debounce(() => {
  const q = searchInput.value.trim();
  if (q.length >= 3) {
    state.search.query = q;
    doSearch();
  }
}, 500);
searchInput.addEventListener("input", debouncedTypeahead);

let searchAbort = null;

async function doSearch() {
  const query = state.search.query;
  if (!query) return;
  closeProgramView();

  if (!state.settings.proxyUrl) {
    state.search.status = "error";
    proxyMissingState(resultsEl, openSettings);
    return;
  }

  searchAbort?.abort();
  searchAbort = new AbortController();

  state.search.status = "loading";
  skeletonGrid(resultsEl, 8);

  try {
    const results = await ivoox.search(query, state.search.type, { signal: searchAbort.signal });
    state.search.results = results;
    state.search.status = results.length ? "success" : "empty";
    renderResults();
  } catch (err) {
    if (err.name === "AbortError") return;
    state.search.status = "error";
    state.search.error = err.message;
    errorState(resultsEl, err.message, doSearch);
  }
}

function renderResults() {
  if (state.search.status === "loading") return skeletonGrid(resultsEl);
  if (state.search.status === "empty") return emptyState(resultsEl, state.search.query);
  if (state.search.status === "error") return errorState(resultsEl, state.search.error, doSearch);
  if (state.search.status === "idle") return idleState(resultsEl);

  resultsEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = state.search.type === "program" ? "grid" : "list";

  for (const item of state.search.results) {
    if (item.type === "program") {
      wrap.appendChild(renderProgramCard(item, openProgram));
    } else {
      wrap.appendChild(renderEpisodeCard(item, handleEpisodeAction, showEpisodeInfo));
    }
  }
  resultsEl.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Vista de programa
// ---------------------------------------------------------------------------
async function openProgram(program) {
  programViewEl.hidden = false;
  heroEl.hidden = true;
  resultsEl.hidden = true;

  state.program = {
    open: true, status: "loading", error: "", info: program, episodes: [],
    page: 1, hasMore: false, loadingMore: false, filterQuery: "",
  };
  episodeFilterEl.value = "";
  renderProgram();

  try {
    const { info, episodes, hasMore } = await ivoox.getProgram(program.url, { page: 1 });
    // iVoox da la descripción del programa en dos sitios con longitudes
    // distintas (la meta-etiqueta de la ficha, y la de la tarjeta de
    // búsqueda) — nos quedamos con la que tenga más texto.
    const description = [info.description, program.author]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || "";
    state.program.info = { ...program, ...info, description };
    state.program.episodes = episodes;
    state.program.hasMore = hasMore;
    state.program.status = episodes.length ? "success" : "empty";
  } catch (err) {
    state.program.status = "error";
    state.program.error = err.message;
  }
  renderProgram();
}

// Scroll infinito: se observa un centinela al final de la lista y, cuando
// entra en el viewport, se pide la siguiente página de episodios de iVoox
// (pagina cambiando el número final de la URL del programa).
const loadMoreObserver = new IntersectionObserver(
  (entries) => { if (entries[0].isIntersecting) loadMoreEpisodes(); },
  { rootMargin: "400px" },
);

async function loadMoreEpisodes() {
  const p = state.program;
  if (p.loadingMore || !p.hasMore || !p.info) return;
  p.loadingMore = true;
  renderLoadMoreIndicator();

  try {
    const nextPage = p.page + 1;
    const { episodes, hasMore } = await ivoox.getProgram(p.info.url, { page: nextPage });
    p.episodes = [...p.episodes, ...episodes];
    p.page = nextPage;
    p.hasMore = hasMore && episodes.length > 0;
  } catch (err) {
    toast(`No se han podido cargar más episodios: ${err.message}`, "error");
    p.hasMore = false; // evita reintentos en bucle si el fallo es persistente
  } finally {
    p.loadingMore = false;
    renderProgram();
  }
}

function closeProgramView() {
  state.program.open = false;
  programViewEl.hidden = true;
  resultsEl.hidden = false;
  heroEl.hidden = false;
}
$("#back-to-results").addEventListener("click", closeProgramView);

episodeFilterEl.addEventListener("input", () => {
  state.program.filterQuery = episodeFilterEl.value;
  renderProgram();
});

function renderProgram() {
  const { status, info, episodes, error } = state.program;

  programHeaderEl.innerHTML = "";
  if (info) {
    const badge = info.isOriginal ? `<span class="tag-original">iVoox Originals</span>` : "";
    const description = (info.description || "").trim();
    const fav = isFavorite(info.id);
    programHeaderEl.innerHTML = `
      <img src="${info.image || ""}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="program-header-body">
        <div class="program-header-title-row">
          <h2>${escapeHtml(info.title)} ${badge}</h2>
          <button type="button" class="favorite-btn${fav ? " is-favorite" : ""}" id="program-favorite-btn"
            aria-label="${fav ? "Quitar de favoritos" : "Añadir a favoritos"}" title="${fav ? "Quitar de favoritos" : "Añadir a favoritos"}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4.5c2-3 7-2.5 7 2 0 4.5-5 7.5-7 9-2-1.5-7-4.5-7-9 0-4.5 5-5 7-2z"/></svg>
          </button>
        </div>
        ${description ? `<p class="program-header-description" id="program-description">${escapeHtml(description)}</p>` : ""}
        <div class="program-header-footer">
          ${description ? `<button type="button" class="read-more-btn" id="program-read-more" hidden>Leer más</button>` : ""}
          <a class="program-header-link" href="${info.url}" target="_blank" rel="noopener noreferrer">
            Ver en iVoox
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M9 7h8v8"/></svg>
          </a>
        </div>
      </div>
    `;

    $("#program-favorite-btn").addEventListener("click", () => {
      toggleFavorite(info);
      renderProgram();
    });

    if (description) {
      const descEl = $("#program-description");
      const btn = $("#program-read-more");
      btn.addEventListener("click", () => {
        const expanded = descEl.classList.toggle("is-expanded");
        btn.textContent = expanded ? "Leer menos" : "Leer más";
      });
      // El botón solo tiene sentido si el texto realmente se corta con el
      // clamp de 3 líneas; se comprueba tras pintar para no mostrarlo de más.
      requestAnimationFrame(() => {
        if (descEl.scrollHeight > descEl.clientHeight + 1) btn.hidden = false;
      });
    }
  }

  episodeFilterEl.hidden = status !== "success";
  if (status === "loading") return skeletonGrid(programEpisodesEl, 5);
  if (status === "error") return errorState(programEpisodesEl, error, () => openProgram(state.program.info));
  if (status === "empty") return emptyState(programEpisodesEl, info?.title || "");

  const query = state.program.filterQuery.trim().toLowerCase();
  const visible = query ? episodes.filter((ep) => ep.title.toLowerCase().includes(query)) : episodes;

  programEpisodesEl.innerHTML = "";
  if (query && visible.length === 0) {
    return emptyState(programEpisodesEl, state.program.filterQuery);
  }
  for (const ep of visible) {
    programEpisodesEl.appendChild(renderEpisodeRow(ep, handleEpisodeAction, showEpisodeInfo));
  }

  loadMoreObserver.disconnect();
  // Con un filtro activo no tiene sentido seguir pidiendo más páginas: el
  // usuario está buscando dentro de lo ya cargado, no navegando la lista.
  if (!query && state.program.hasMore) {
    const sentinel = document.createElement("div");
    sentinel.className = "load-more-sentinel";
    programEpisodesEl.appendChild(sentinel);
    renderLoadMoreIndicator();
    loadMoreObserver.observe(sentinel);
  }
}

function renderLoadMoreIndicator() {
  const sentinel = programEpisodesEl.querySelector(".load-more-sentinel");
  if (!sentinel) return;
  sentinel.innerHTML = state.program.loadingMore
    ? `<span class="spinner"></span> Cargando más episodios…`
    : "";
}

// ---------------------------------------------------------------------------
// Popup de "+info" de episodio
// ---------------------------------------------------------------------------
function showEpisodeInfo(episode) {
  openEpisodeModal(episode, handleEpisodeAction, actionButton);
}

// ---------------------------------------------------------------------------
// Descarga + subida de un episodio
// ---------------------------------------------------------------------------
async function handleEpisodeAction(episode, btn) {
  if (state.pocketcasts.status !== "connected") {
    toast("Conecta tu cuenta de Pocket Casts antes de subir episodios.", "error");
    openSettings();
    return;
  }
  await runEpisodeJob(episode);
  const job = getJob(episode.id);
  if (job.status === "done") {
    recordUpload(episode);
    toast(`“${episode.title}” subido a Pocket Casts`, "success");
  }
  if (job.status === "error") toast(job.error, "error");
}

// ---------------------------------------------------------------------------
// Render reactivo global (botones de acción + estado de conexión PC)
// ---------------------------------------------------------------------------
/**
 * Estado combinado que se ve en la cabecera: antes solo reflejaba Pocket
 * Casts, pero si el Worker no está configurado o no responde el usuario
 * veía "Pocket Casts desconectado" sin ninguna pista de que el problema
 * real era el puente, no la cuenta.
 */
function computeOverallStatus() {
  const w = state.worker.status;
  const pc = state.pocketcasts;

  if (!state.settings.proxyUrl) return { dot: "disconnected", label: "Configura el Worker" };
  if (w === "checking" || w === "unknown") return { dot: "connecting", label: "Comprobando conexión…" };
  if (w === "error") return { dot: "error", label: "El Worker no responde" };

  if (pc.status === "connecting") return { dot: "connecting", label: "Conectando a Pocket Casts…" };
  if (pc.status === "error") return { dot: "error", label: "Error con Pocket Casts" };
  if (pc.status === "connected") return { dot: "connected", label: `Conectado como ${pc.email}` };
  return { dot: "disconnected", label: "Pocket Casts desconectado" };
}

function render() {
  const pc = state.pocketcasts;
  const overall = computeOverallStatus();
  $(".pc-dot").dataset.state = overall.dot;
  $("#pc-status-label").textContent = overall.label;

  const workerHealthEl = $("#worker-health");
  workerHealthEl.className = "worker-health";
  if (!state.settings.proxyUrl) {
    workerHealthEl.textContent = "";
  } else if (state.worker.status === "checking" || state.worker.status === "unknown") {
    workerHealthEl.textContent = "Comprobando conexión con el Worker…";
  } else if (state.worker.status === "ok") {
    workerHealthEl.textContent = "✓ El Worker responde correctamente";
    workerHealthEl.classList.add("is-ok");
  } else {
    workerHealthEl.textContent = "✗ El Worker no responde en esa URL";
    workerHealthEl.classList.add("is-error");
  }

  const connected = pc.status === "connected";
  $("#pc-login-fields").hidden = connected;
  $("#pc-connected-info").hidden = !connected;
  $("#pc-connected-email").textContent = pc.email;
  $("#pc-login-btn").disabled = pc.status === "connecting";
  if (!connected) $("#pc-email").value = pc.email;

  const rememberSupported = rememberMeSupported();
  $("#pc-remember-field").hidden = !rememberSupported;
  $("#pc-remember-hint").hidden = !(connected && pc.remember);

  document.querySelectorAll(".action-btn[data-episode-id]").forEach((btn) => {
    const id = btn.dataset.episodeId;
    const episode = [...state.search.results, ...state.program.episodes].find((e) => e.id === id);
    if (episode) applyJobState(btn, episode);
  });

  if (state.search.type === "favorites" && !state.program.open) renderFavorites();
}

// Refrescar/cerrar la pestaña corta de raíz cualquier descarga o subida en
// curso (es una petición del propio navegador, no se puede reanudar desde
// aquí) — al menos avisamos para no perder el trabajo sin darse cuenta.
window.addEventListener("beforeunload", (e) => {
  const hasActiveJob = [...state.jobs.values()].some(
    (j) => j.status === "downloading" || j.status === "uploading",
  );
  if (hasActiveJob) {
    e.preventDefault();
    e.returnValue = "";
  }
});

subscribe(render);
render();
idleState(resultsEl);
