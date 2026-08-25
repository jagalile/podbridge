// Store minúsculo tipo pub/sub. Nada de frameworks: nos basta para una SPA
// de una sola pantalla con un puñado de vistas.
//
// Qué se persiste y dónde (y por qué):
//   - URL del Worker            → localStorage (no es sensible)
//   - Favoritos, historial       → localStorage (no es sensible)
//   - Token de Pocket Casts       → sessionStorage siempre (memoria de la
//                                    pestaña); si el usuario activa
//                                    "recordarme", ADEMÁS se guarda
//                                    cifrado en localStorage (ver
//                                    crypto-store.js) para poder restaurar
//                                    la sesión en visitas futuras sin
//                                    volver a pedir la contraseña.
//   - Contraseña de Pocket Casts → nunca se persiste en ningún sitio, ni
//                                    cifrada. Solo viaja una vez, hacia el
//                                    Worker, en el momento del login.

import { encryptText, decryptText, cryptoStoreSupported } from "./crypto-store.js";

const listeners = new Set();

const FAVORITES_KEY = "pb.favorites";
const HISTORY_KEY = "pb.uploadHistory";
const REMEMBER_KEY = "pb.pc.remember";
const REMEMBERED_EMAIL_KEY = "pb.pc.rememberedEmail";
const PERSISTED_TOKEN_KEY = "pb.pc.encryptedToken";

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export const state = {
  settings: {
    proxyUrl: localStorage.getItem("pb.proxyUrl") || "",
  },
  worker: {
    status: "unknown", // unknown | checking | ok | error (solo si hay proxyUrl configurada)
  },
  pocketcasts: {
    email: sessionStorage.getItem("pb.pc.email") || "",
    token: sessionStorage.getItem("pb.pc.token") || "",
    status: sessionStorage.getItem("pb.pc.token") ? "connected" : "disconnected", // disconnected | connecting | connected | error
    error: "",
    remember: localStorage.getItem(REMEMBER_KEY) === "1",
  },
  search: {
    type: "program",       // "program" | "episode" | "favorites"
    query: "",
    status: "idle",         // idle | loading | success | empty | error
    error: "",
    results: [],
  },
  program: {
    open: false,
    status: "idle",         // idle | loading | success | empty | error
    error: "",
    info: null,
    episodes: [],
    page: 1,
    hasMore: false,
    loadingMore: false,
    filterQuery: "",
  },
  favorites: loadJSON(FAVORITES_KEY, []),          // [{id, title, image, url, isOriginal, author}]
  uploadHistory: loadJSON(HISTORY_KEY, {}),        // { [episodeId]: { title, uploadedAt } }
  // episodeId -> { status: idle|downloading|uploading|done|error, progress, error }
  jobs: new Map(),
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) fn(state);
}

export function setJob(id, patch) {
  const prev = state.jobs.get(id) || { status: "idle", progress: 0, error: "" };
  state.jobs.set(id, { ...prev, ...patch });
  notify();
}

/** Si no hay job activo en esta sesión pero el episodio ya se subió antes
 * (historial persistido), se refleja igualmente como "hecho". */
export function getJob(id) {
  const job = state.jobs.get(id);
  if (job) return job;
  if (state.uploadHistory[id]) return { status: "done", progress: 1, error: "" };
  return { status: "idle", progress: 0, error: "" };
}

export function saveProxyUrl(url) {
  state.settings.proxyUrl = url.trim().replace(/\/+$/, "");
  localStorage.setItem("pb.proxyUrl", state.settings.proxyUrl);
  state.worker.status = "unknown";
  notify();
}

export function setWorkerStatus(status) {
  state.worker.status = status;
  notify();
}

export function setPocketCasts(patch) {
  Object.assign(state.pocketcasts, patch);
  if ("token" in patch) {
    if (patch.token) sessionStorage.setItem("pb.pc.token", patch.token);
    else sessionStorage.removeItem("pb.pc.token");
  }
  if ("email" in patch) {
    if (patch.email) sessionStorage.setItem("pb.pc.email", patch.email);
    else sessionStorage.removeItem("pb.pc.email");
  }
  notify();
}

export function logoutPocketCasts() {
  setPocketCasts({ token: "", email: "", status: "disconnected", error: "", remember: false });
  clearPersistedPocketCastsSession();
}

// ---------------------------------------------------------------------------
// Sesión de Pocket Casts recordada entre visitas (cifrada, ver crypto-store.js)
// ---------------------------------------------------------------------------

export function rememberMeSupported() {
  return cryptoStoreSupported();
}

/** Se llama tras un login correcto, con la casilla "recordarme" marcada o no. */
export async function persistPocketCastsSession(remember, email, token) {
  if (!remember) {
    clearPersistedPocketCastsSession();
    return;
  }
  try {
    const payload = await encryptText(token);
    localStorage.setItem(PERSISTED_TOKEN_KEY, JSON.stringify(payload));
    localStorage.setItem(REMEMBER_KEY, "1");
    localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
  } catch {
    // Si el cifrado falla (navegador sin IndexedDB, modo privado muy
    // restrictivo...) no se persiste nada; la sesión sigue funcionando
    // igual dentro de esta pestaña vía sessionStorage.
    clearPersistedPocketCastsSession();
  }
}

export function clearPersistedPocketCastsSession() {
  localStorage.removeItem(PERSISTED_TOKEN_KEY);
  localStorage.removeItem(REMEMBER_KEY);
  localStorage.removeItem(REMEMBERED_EMAIL_KEY);
}

/** Se llama una vez al arrancar la app. No hace nada si ya hay sesión en
 * esta pestaña o si el usuario nunca activó "recordarme". */
export async function restorePersistedPocketCastsSession() {
  if (state.pocketcasts.token) return; // ya conectado en esta pestaña
  if (localStorage.getItem(REMEMBER_KEY) !== "1") return;

  const raw = localStorage.getItem(PERSISTED_TOKEN_KEY);
  if (!raw) return;

  try {
    const token = await decryptText(JSON.parse(raw));
    const email = localStorage.getItem(REMEMBERED_EMAIL_KEY) || "";
    setPocketCasts({ status: "connected", token, email, remember: true, error: "" });
  } catch {
    // Clave no disponible (otro navegador/perfil) o dato corrupto: se
    // descarta en vez de dejar la app en un estado confuso.
    clearPersistedPocketCastsSession();
  }
}

// ---------------------------------------------------------------------------
// Favoritos
// ---------------------------------------------------------------------------

export function isFavorite(programId) {
  return state.favorites.some((f) => f.id === programId);
}

export function toggleFavorite(program) {
  const idx = state.favorites.findIndex((f) => f.id === program.id);
  if (idx === -1) {
    state.favorites = [
      { id: program.id, title: program.title, image: program.image, url: program.url, isOriginal: !!program.isOriginal, author: program.author || "" },
      ...state.favorites,
    ];
  } else {
    state.favorites = state.favorites.filter((f) => f.id !== program.id);
  }
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  notify();
}

// ---------------------------------------------------------------------------
// Historial de episodios ya subidos
// ---------------------------------------------------------------------------

export function recordUpload(episode) {
  state.uploadHistory = {
    ...state.uploadHistory,
    [episode.id]: { title: episode.title, uploadedAt: Date.now() },
  };
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.uploadHistory));
  notify();
}
