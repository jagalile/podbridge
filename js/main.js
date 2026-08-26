import {
  state, subscribe, saveProxyUrl, saveRelayUrl, saveRelaySecret, setWorkerStatus, setRelayStatus, setPocketCasts, logoutPocketCasts, getJob,
  isFavorite, toggleFavorite, recordUpload,
  rememberMeSupported, persistPocketCastsSession, restorePersistedPocketCastsSession,
  exportData, importData, recordDataSync, hasUnsyncedChanges, setUsage,
} from "./state.js";
import * as ivoox from "./api/ivoox.js";
import * as pocketcasts from "./api/pocketcasts.js";
import { pingWorker } from "./api/proxy.js";
import { pingRelay } from "./api/relay.js";
import { runEpisodeJob } from "./download.js";
import { toast } from "./components/toast.js";
import { skeletonGrid, skeletonList, idleState, emptyState, emptyFavoritesState, emptyFavoriteEpisodesState, errorState, proxyMissingState } from "./components/states.js";
import { renderProgramCard, renderProgramRow, renderEpisodeCard, renderEpisodeRow, applyJobState, actionButton } from "./components/cards.js";
import { openOverlay, closeOverlay } from "./components/overlay.js";
import { openEpisodeModal } from "./components/episodeModal.js";
import { debounce, escapeHtml, fmtBytes, parseRelativeDate, fmtRelativeTime } from "./utils.js";

const $ = (sel) => document.querySelector(sel);

const resultsEl = $("#results");
const heroEl = $(".hero");
const programViewEl = $("#program-view");
const programHeaderEl = $("#program-header");
const programEpisodesEl = $("#program-episodes");
const episodeFilterEl = $("#program-episode-filter");
const episodeSearchWrapEl = $(".program-episode-search");

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
const settingsPanel = $("#settings-panel");

/** Refleja en los campos del panel lo que haya en el store — hace falta
 * llamarlo no solo al abrir Ajustes, sino también tras importar datos
 * (el panel de "Tus datos" vive dentro del propio panel de Ajustes, así
 * que puede seguir abierto con los campos ya pintados con los valores
 * viejos cuando la importación cambia la URL del Worker o el relevo). */
function syncSettingsFields() {
  $("#proxy-url").value = state.settings.proxyUrl;
  $("#relay-url").value = state.settings.relayUrl;
  $("#relay-secret").value = state.settings.relaySecret;
}

function openSettings() {
  syncSettingsFields();
  openOverlay(settingsPanel);
}
function closeSettings() {
  closeOverlay();
}
$("#open-settings").addEventListener("click", openSettings);

// ---------------------------------------------------------------------------
// Tooltips de la cabecera (estado de conexión, descargas/subidas en curso)
//
// Ninguno de los dos abre Ajustes — eso ya lo hace el engranaje de al
// lado. Cada uno enseña un resumen corto en la pastilla y, al pasar el
// ratón o al pulsarla (para pantallas táctiles, donde no hay hover), un
// detalle en un popover propio. Misma mecánica para los dos, así que va
// en una única función en vez de duplicar el código de apertura/cierre.
// Los dos triggers cortan la propagación del clic (e.stopPropagation())
// para que el clic que los abre no cierre el suyo propio al llegar al
// listener de "fuera" de más abajo — pero eso significa que si el
// segundo tooltip está abierto cuando se pulsa el primero, ese clic
// nunca llega al listener de "fuera" del segundo (la propagación se
// cortó antes), y se quedaban los dos abiertos a la vez. Por eso hace
// falta que abrir uno cierre explícitamente el resto, no basta con el
// cierre "al pulsar fuera".
const statusTooltips = [];
function wireStatusTooltip(triggerEl, tooltipEl) {
  statusTooltips.push({ trigger: triggerEl, tooltip: tooltipEl });
  triggerEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !tooltipEl.classList.contains("is-open");
    for (const other of statusTooltips) {
      if (other.tooltip === tooltipEl) continue;
      other.tooltip.classList.remove("is-open");
      other.trigger.setAttribute("aria-expanded", "false");
    }
    tooltipEl.classList.toggle("is-open", willOpen);
    triggerEl.setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", (e) => {
    if (!tooltipEl.classList.contains("is-open")) return;
    if (e.target === triggerEl || triggerEl.contains(e.target)) return;
    tooltipEl.classList.remove("is-open");
    triggerEl.setAttribute("aria-expanded", "false");
  });
}

wireStatusTooltip($("#pc-status-btn"), $("#status-tooltip"));
wireStatusTooltip($("#jobs-status-btn"), $("#jobs-tooltip"));

$("#close-settings").addEventListener("click", closeSettings);

// Botón del ojo en los campos de contraseña/secreto: alterna entre
// type="password" (puntos) y type="text" (en claro) mientras se pulsa,
// y cambia el propio icono para que se note en qué estado se ha quedado.
const EYE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A11 11 0 0 1 12 5c7 0 11 7 11 7a13.2 13.2 0 0 1-3.2 3.9M6.5 6.6C3.4 8.4 1 12 1 12s4 7 11 7a10.5 10.5 0 0 0 4.1-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;
document.querySelectorAll(".field-toggle-visibility").forEach((btn) => {
  const input = $(`#${btn.dataset.for}`);
  btn.innerHTML = EYE_ICON;
  btn.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.innerHTML = show ? EYE_OFF_ICON : EYE_ICON;
    btn.setAttribute("aria-label", show ? "Ocultar" : "Mostrar");
  });
});

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

$("#save-relay").addEventListener("click", () => {
  const url = $("#relay-url").value;
  if (url && !/^https?:\/\//.test(url)) {
    toast("La URL del servicio de relevo debe empezar por https://", "error");
    return;
  }
  saveRelayUrl(url);
  saveRelaySecret($("#relay-secret").value);
  const status = $("#relay-status");
  status.textContent = url ? "Guardado ✓" : "";
  setTimeout(() => { status.textContent = ""; }, 2500);
  checkRelay();
});

/** Comprueba si el Worker configurado responde (GET /health). */
async function checkWorker() {
  if (!state.settings.proxyUrl) { setWorkerStatus("unknown"); return; }
  setWorkerStatus("checking");
  const ok = await pingWorker(state.settings.proxyUrl);
  setWorkerStatus(ok ? "ok" : "error");
}
checkWorker();

// Por encima de esto, el ping tarda tanto que lo más probable es que el
// servicio estuviera dormido (plan gratuito de Render) y este ping lo
// haya despertado — no hay forma de preguntárselo directamente.
const RELAY_SLEEP_THRESHOLD_MS = 3000;

/** Comprueba si el servicio de relevo configurado responde (GET /health). */
async function checkRelay() {
  if (!state.settings.relayUrl) { setRelayStatus("unknown"); return; }
  setRelayStatus("checking");
  const { ok, ms, reason } = await pingRelay(state.settings.relayUrl);
  setRelayStatus(ok ? "ok" : "error", { wasSleeping: ms >= RELAY_SLEEP_THRESHOLD_MS, failReason: reason || null });
}
checkRelay();

// Botón para despertar el relevo a mano — pensado para pulsarlo un
// minuto antes de subir un episodio grande, en vez de que esa primera
// subida del día se coma los 30-50s de arranque en frío del plan
// gratuito de Render.
$("#wake-relay").addEventListener("click", async (e) => {
  if (!state.settings.relayUrl) {
    toast("Configura primero la URL del servicio de relevo.", "error");
    return;
  }
  const btn = e.currentTarget;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Comprobando…";
  await checkRelay();
  btn.textContent = originalText;
  btn.disabled = false;

  const { status, wasSleeping } = state.relay;
  if (status === "ok") {
    toast(wasSleeping ? "Estaba dormido — ya está despierto y listo." : "Ya estaba activo.", "success");
  } else {
    toast("No se ha podido contactar con el relevo — revisa la URL y el secreto.", "error");
  }
});

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
    await persistPocketCastsSession(remember, email, token);
    toast(remember ? "Conectado a Pocket Casts (sesión recordada en este dispositivo)" : "Conectado a Pocket Casts", "success");
    loadUsage();
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

// Un único interruptor "recordarme", siempre en el mismo sitio, que sirve
// tanto antes de conectar (se aplica en el submit de arriba) como ya
// conectado (se aplica al momento aquí mismo) — antes había dos casillas
// distintas según el estado, y quien conectaba antes de que existiera esta
// opción (o sin marcarla) no tenía forma de activarla sin desconectar.
$("#pc-remember").addEventListener("change", async (e) => {
  if (state.pocketcasts.status !== "connected") return; // se decide al conectar, ver submit de arriba
  const checked = e.target.checked;
  setPocketCasts({ remember: checked });
  await persistPocketCastsSession(checked, state.pocketcasts.email, state.pocketcasts.token);
  toast(checked ? "Este dispositivo recordará la sesión" : "Sesión ya no recordada en este dispositivo", "info");
  render();
});

/** Consulta el espacio usado en Archivos de Pocket Casts (silencioso si falla). */
async function loadUsage() {
  if (state.pocketcasts.status !== "connected") return;
  try {
    const usage = await pocketcasts.getUsage(state.pocketcasts.token);
    if ((!usage.usedBytes || !usage.totalBytes) && usage.debug) {
      // No debería pasar, pero por si acaso: si algún día vuelve a venir
      // vacío, esto deja en la consola justo lo que hace falta para verlo
      // sin tener que pedir credenciales de nadie.
      console.warn("PodBridge: /pocketcasts/usage no trajo datos usables", usage.debug);
    }
    setUsage(usage);
  } catch {
    // no es crítico; si falla, simplemente no se muestra la barra de uso
  }
}

// Restaura la sesión de Pocket Casts si el usuario activó "recordarme" en
// una visita anterior (token cifrado en localStorage, ver state.js).
restorePersistedPocketCastsSession().then(() => { render(); loadUsage(); });

// ---------------------------------------------------------------------------
// Exportar / importar datos (favoritos, historial, URL del Worker)
// ---------------------------------------------------------------------------
$("#export-data").addEventListener("click", () => {
  const data = exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `podbridge-datos-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  $("#data-io-status").textContent = "Exportado ✓";
  setTimeout(() => { $("#data-io-status").textContent = ""; }, 2500);
  recordDataSync("export");
  renderDataSyncStatus();
});

const importInput = $("#import-data-input");
$("#import-data-btn").addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  importInput.value = ""; // permite volver a elegir el mismo archivo después
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = importData(data, { merge: true });

    const settingsApplied = [
      result.proxyUrlApplied && "la URL del Worker",
      result.relayUrlApplied && "el relevo",
      result.relaySecretApplied && "su secreto",
    ].filter(Boolean);
    toast(
      `Importado: ${result.favorites} favoritos, ${result.uploads} episodios en el historial` +
        (settingsApplied.length ? ` y ${settingsApplied.join(", ")}` : ""),
      "success",
    );
    syncSettingsFields(); // el panel de ajustes puede seguir abierto con los campos desactualizados
    if (result.proxyUrlApplied) checkWorker();
    if (result.relayUrlApplied) checkRelay();
    recordDataSync("import");
    render();
  } catch (err) {
    toast(`No se ha podido importar el archivo: ${err.message}`, "error");
  }
});

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
const searchForm = $("#search-form");
const searchInput = $("#search-input");

// El botón "Buscar" se queda oculto en el HTML (solo para que Enter siga
// enviando el formulario en cualquier navegador): la búsqueda se dispara
// sola al escribir, igual que el filtro de la pestaña Favoritos.
const SEARCH_PLACEHOLDERS = {
  program: "Ej. “La Script” o “Nadie Sabe Nada”",
  favorites: "Buscar en tus favoritos…",
  "favorite-episodes": "Buscar en los episodios de tus favoritos…",
};

document.querySelectorAll(".search-type .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".search-type .chip").forEach((c) => {
      c.classList.remove("is-active");
      c.setAttribute("aria-selected", "false");
    });
    chip.classList.add("is-active");
    chip.setAttribute("aria-selected", "true");
    state.search.type = chip.dataset.type;
    state.search.query = "";
    searchInput.value = "";
    searchInput.placeholder = SEARCH_PLACEHOLDERS[state.search.type];

    if (state.search.type === "favorites") renderFavorites();
    else if (state.search.type === "favorite-episodes") loadFavoriteEpisodes();
    else renderResults();
  });
});

/** Filtra localmente los favoritos por título — no hay red de por medio. */
function renderFavorites() {
  closeProgramView();
  const query = state.search.query.trim().toLowerCase();
  const visible = query
    ? state.favorites.filter((f) => f.title.toLowerCase().includes(query))
    : state.favorites;

  if (state.favorites.length === 0) {
    emptyFavoritesState(resultsEl);
    return;
  }
  if (visible.length === 0) {
    emptyState(resultsEl, state.search.query);
    return;
  }
  resultsEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "list";
  for (const program of visible) {
    wrap.appendChild(renderProgramRow(program, openProgram));
  }
  resultsEl.appendChild(wrap);
}

/**
 * Trae los episodios de todos los programas favoritos (una petición por
 * programa, en paralelo — ya sale de /ivoox/program, sin nada nuevo del
 * lado del Worker), los fusiona y los ordena por fecha aproximada (ver
 * parseRelativeDate). Si algún favorito falla, no rompe el resto — se
 * queda sin sus episodios en vez de tirar toda la lista por la borda.
 * Se recarga entero cada vez que se entra en esta pestaña: es justo lo
 * que se busca al abrirla (¿hay algo nuevo?), así que reutilizar datos
 * viejos iría en contra del propósito.
 */
async function loadFavoriteEpisodes() {
  closeProgramView();

  if (state.favorites.length === 0) {
    state.favoriteEpisodes = { status: "empty", error: "", episodes: [] };
    emptyFavoritesState(resultsEl);
    return;
  }
  if (!state.settings.proxyUrl) {
    state.favoriteEpisodes.status = "error";
    proxyMissingState(resultsEl, openSettings);
    return;
  }

  state.favoriteEpisodes.status = "loading";
  skeletonList(resultsEl, 6);

  try {
    const perProgram = await Promise.all(
      state.favorites.map(async (fav) => {
        try {
          const { episodes } = await ivoox.getProgram(fav.url, { page: 1 });
          return episodes;
        } catch {
          return []; // un favorito que falla no debe tirar el resto de la lista
        }
      }),
    );
    const episodes = perProgram.flat().sort(
      (a, b) => parseRelativeDate(b.date) - parseRelativeDate(a.date),
    );
    state.favoriteEpisodes = { status: episodes.length ? "success" : "empty", error: "", episodes };
    renderFavoriteEpisodesList();
  } catch (err) {
    state.favoriteEpisodes.status = "error";
    state.favoriteEpisodes.error = err.message;
    errorState(resultsEl, err.message, loadFavoriteEpisodes);
  }
}

/** Pura: pinta state.favoriteEpisodes.episodes (con el filtro de texto
 * aplicado) sin volver a pedir nada a la red — para el filtro al escribir
 * y para refrescos reactivos (p.ej. cuando cambia el estado de un job). */
function renderFavoriteEpisodesList() {
  // No depende de state.favoriteEpisodes.status para esto — puede haber
  // quedado en "success" de antes si el usuario quita su último favorito
  // mientras sigue en esta pestaña.
  if (state.favorites.length === 0) return emptyFavoritesState(resultsEl);

  const { status, error, episodes } = state.favoriteEpisodes;
  if (status === "loading") return skeletonList(resultsEl, 6);
  if (status === "error") return errorState(resultsEl, error, loadFavoriteEpisodes);

  const query = state.search.query.trim().toLowerCase();
  const visible = query ? episodes.filter((ep) => ep.title.toLowerCase().includes(query)) : episodes;

  if (episodes.length === 0) {
    return emptyFavoriteEpisodesState(resultsEl);
  }
  if (query && visible.length === 0) {
    return emptyState(resultsEl, state.search.query);
  }

  resultsEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "list";
  for (const ep of visible) {
    wrap.appendChild(renderEpisodeCard(ep, handleEpisodeAction, showEpisodeInfo));
  }
  resultsEl.appendChild(wrap);
}

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  state.search.query = searchInput.value.trim();
  if (state.search.type === "favorites") renderFavorites();
  else if (state.search.type === "favorite-episodes") renderFavoriteEpisodesList();
  else doSearch();
});

const debouncedTypeahead = debounce(() => {
  const q = searchInput.value.trim();
  if (q.length >= 3) {
    state.search.query = q;
    doSearch();
  }
}, 500);
searchInput.addEventListener("input", () => {
  if (state.search.type === "favorites") {
    state.search.query = searchInput.value;
    renderFavorites();
  } else if (state.search.type === "favorite-episodes") {
    state.search.query = searchInput.value;
    renderFavoriteEpisodesList();
  } else {
    debouncedTypeahead();
  }
});

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
    const results = await ivoox.search(query, { signal: searchAbort.signal });
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
  wrap.className = "grid";
  for (const item of state.search.results) {
    wrap.appendChild(renderProgramCard(item, openProgram));
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
    // Antes de que responda /ivoox/program, `info` es solo la tarjeta de
    // búsqueda/favorito que ya teníamos (sin `description`, esa solo
    // llega con la ficha completa) — usar `author` como texto provisional
    // evita que la descripción tarde en aparecer pudiendo mostrar algo
    // desde el primer render en vez de esperar a la respuesta completa.
    const description = (info.description || info.author || "").trim();
    const fav = isFavorite(info.id);
    programHeaderEl.innerHTML = `
      <img src="${info.image || ""}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="program-header-body">
        <div class="program-header-title-row">
          <h2>${escapeHtml(info.title)} ${badge}</h2>
          <button type="button" class="favorite-btn${fav ? " is-favorite" : ""}" id="program-favorite-btn"
            aria-label="${fav ? "Quitar de favoritos" : "Añadir a favoritos"}" title="${fav ? "Quitar de favoritos" : "Añadir a favoritos"}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.3C12 20.3 4 15.4 4 9.6 4 6.5 6.5 4.5 9 4.5c1.5 0 2.5.8 3 1.8.5-1 1.5-1.8 3-1.8 2.5 0 5 2 5 5.1 0 5.8-8 10.7-8 10.7z"/></svg>
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
      const wasFavorite = isFavorite(info.id);
      toggleFavorite(info);
      if (wasFavorite) {
        toast(`“${info.title}” quitado de favoritos`, "info", {
          actionLabel: "Deshacer",
          onAction: () => { toggleFavorite(info); renderProgram(); },
        });
      }
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

  // Se esconde el buscador entero (input + icono de lupa), no solo el
  // input — escondiendo solo el input, el icono se quedaba flotando
  // solo mientras cargaba, sin nada de caja alrededor.
  episodeSearchWrapEl.hidden = status !== "success";
  if (status === "loading") return skeletonList(programEpisodesEl, 5);
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
 * Estado combinado que se ve en la pastilla de la cabecera: un resumen
 * genérico y corto (el detalle completo, Worker y Pocket Casts por
 * separado, va en el tooltip — ver computeConnectionDetails).
 */
function computeOverallStatus() {
  const w = state.worker.status;
  const pc = state.pocketcasts;

  if (!state.settings.proxyUrl) return { dot: "disconnected", label: "Sin configurar" };
  if (w === "checking" || w === "unknown") return { dot: "connecting", label: "Comprobando…" };
  if (w === "error") return { dot: "error", label: "Error de conexión" };

  if (pc.status === "connecting") return { dot: "connecting", label: "Conectando…" };
  if (pc.status === "error") return { dot: "error", label: "Error de conexión" };
  if (pc.status === "connected") return { dot: "connected", label: "Conectado" };
  return { dot: "disconnected", label: "Desconectado" };
}

/** Detalle del Worker y de Pocket Casts por separado, para el tooltip. */
function computeConnectionDetails() {
  const w = state.worker.status;
  const pc = state.pocketcasts;

  let worker;
  if (!state.settings.proxyUrl) worker = { dot: "disconnected", text: "Sin configurar" };
  else if (w === "checking" || w === "unknown") worker = { dot: "connecting", text: "Comprobando conexión…" };
  else if (w === "ok") worker = { dot: "connected", text: "Responde correctamente" };
  else worker = { dot: "error", text: "No responde en esa URL" };

  let pocket;
  if (pc.status === "connecting") pocket = { dot: "connecting", text: "Conectando…" };
  else if (pc.status === "error") pocket = { dot: "error", text: pc.error || "Error de conexión" };
  else if (pc.status === "connected") pocket = { dot: "connected", text: `Conectado como ${pc.email}` };
  else pocket = { dot: "disconnected", text: "Desconectado" };

  // El relevo es opcional (solo hace falta para episodios de más de
  // 100 MB) y, a diferencia del Worker o Pocket Casts, puede estar
  // "dormido" (plan gratuito de Render) sin que eso sea un fallo real —
  // se distingue de un error de verdad para no dar una falsa alarma.
  const r = state.relay;
  let relay;
  if (!state.settings.relayUrl) relay = { dot: "disconnected", text: "Sin configurar (opcional)" };
  else if (r.status === "checking" || r.status === "unknown") relay = { dot: "connecting", text: "Comprobando conexión…" };
  else if (r.status === "ok" && r.wasSleeping) relay = { dot: "connected", text: "Activo (estaba dormido, ya despierto)" };
  else if (r.status === "ok") relay = { dot: "connected", text: "Activo" };
  // Un fallo real se distingue en tres casos — si no, todos se verían
  // igual de "no responde" sin dar ninguna pista de qué mirar:
  else if (r.failReason === "timeout") relay = { dot: "error", text: "No responde tras esperar 1 min — puede seguir dormido o estar caído, prueba otra vez en un rato" };
  else if (r.failReason === "http") relay = { dot: "error", text: "Está despierto pero responde con error — revisa el despliegue en Render" };
  else relay = { dot: "error", text: "No se ha podido contactar — revisa la URL o tu conexión" };

  return { worker, pocket, relay };
}

function render() {
  const pc = state.pocketcasts;
  const overall = computeOverallStatus();
  $("#pc-status-btn .pc-dot").dataset.state = overall.dot;
  $("#pc-status-label").textContent = overall.label;

  const { worker: workerDetail, pocket: pocketDetail, relay: relayDetail } = computeConnectionDetails();
  $("#tooltip-worker-dot").dataset.state = workerDetail.dot;
  $("#tooltip-worker-text").textContent = workerDetail.text;
  $("#tooltip-pc-dot").dataset.state = pocketDetail.dot;
  $("#tooltip-pc-text").textContent = pocketDetail.text;
  $("#tooltip-relay-dot").dataset.state = relayDetail.dot;
  $("#tooltip-relay-text").textContent = relayDetail.text;

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

  $("#pc-remember-field").hidden = !rememberMeSupported();
  $("#pc-remember").checked = pc.remember;
  $("#pc-remember-hint").hidden = !(connected && pc.remember);

  const usageEl = $("#pc-usage");
  usageEl.hidden = !(connected && pc.usage);
  if (connected && pc.usage) {
    const { usedBytes, totalBytes } = pc.usage;
    const pct = totalBytes ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;
    $("#pc-usage-text").textContent = `${fmtBytes(usedBytes)} de ${fmtBytes(totalBytes)} (${pct}%)`;
    const fill = $("#pc-usage-fill");
    fill.style.width = `${pct}%`;
    fill.classList.toggle("is-full", pct >= 90);
  }

  document.querySelectorAll(".action-btn[data-episode-id]").forEach((btn) => {
    const id = btn.dataset.episodeId;
    const episode = [...state.search.results, ...state.program.episodes, ...state.favoriteEpisodes.episodes]
      .find((e) => e.id === id);
    if (episode) applyJobState(btn, episode);
  });

  renderActiveJobs();
  renderDataSyncStatus();

  if (!state.program.open) {
    if (state.search.type === "favorites") renderFavorites();
    else if (state.search.type === "favorite-episodes") renderFavoriteEpisodesList();
  }
}

/**
 * "Control de versiones" sencillo del export/import: cuándo fue la
 * última copia y si hay cambios desde entonces — para no descubrir que
 * hace meses que no exportas justo cuando se estropea el navegador.
 */
function renderDataSyncStatus() {
  const el = $("#data-sync-status");
  const { lastExportedAt, lastImportedAt } = state.dataSync;
  const changed = hasUnsyncedChanges();

  el.classList.toggle("is-attention", changed);

  // Se enseñan las dos fechas por separado (no solo la más reciente): si
  // has importado en un navegador nuevo y luego exportas desde ahí, las
  // dos son datos útiles, no uno solo tapando al otro.
  const lines = [];
  if (lastExportedAt) lines.push(`Última exportación: ${fmtRelativeTime(lastExportedAt)}.`);
  if (lastImportedAt) lines.push(`Última importación: ${fmtRelativeTime(lastImportedAt)}.`);

  if (lines.length === 0) {
    el.textContent = changed
      ? "Nunca se ha exportado — hazlo para no perder tus favoritos y tu historial."
      : "Todavía no hay nada que exportar.";
    return;
  }

  if (changed) lines.push("Hay cambios sin exportar — te recomendamos exportar de nuevo.");
  else lines.push("Sin cambios desde entonces.");
  el.innerHTML = lines.join("<br>");
}

/**
 * Indicador global de descargas/subidas en curso, con su propio popover
 * (mismo patrón que el de estado de conexión). El título de cada fila
 * sale del propio job (ver download.js), no de las listas de resultados
 * actuales — así sigue viéndose aunque el usuario haya navegado a otra
 * búsqueda mientras el episodio seguía en marcha.
 */
function renderActiveJobs() {
  const active = [...state.jobs.entries()].filter(
    ([, job]) => job.status === "downloading" || job.status === "uploading",
  );

  $("#jobs-status-wrap").hidden = active.length === 0;
  if (active.length === 0) return;

  $("#jobs-status-label").textContent = active.length === 1 ? "1 en curso" : `${active.length} en curso`;

  const listEl = $("#jobs-tooltip-list");
  $("#jobs-tooltip-empty").hidden = true;
  listEl.innerHTML = active
    .map(([id, job]) => {
      const pct = Math.round((job.progress || 0) * 100);
      // La fase de subida real no tiene progreso en bytes (pasa entera
      // por el Worker, de iVoox a Pocket Casts) — se muestra como tal en
      // vez de fingir un porcentaje que no significa nada.
      const statusText = job.indeterminate
        ? "Subiendo el audio…"
        : job.status === "downloading" ? `Descargando… ${pct}%` : `Subiendo… ${pct}%`;
      const barFill = job.indeterminate
        ? `<div class="job-row-bar-fill is-indeterminate"></div>`
        : `<div class="job-row-bar-fill" style="width:${pct}%"></div>`;
      return `
        <div class="job-row" data-episode-id="${id}">
          <p class="job-row-title">${escapeHtml(job.title || "Episodio")}</p>
          <p class="job-row-status">${statusText}</p>
          <div class="job-row-bar">${barFill}</div>
        </div>
      `;
    })
    .join("");
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
