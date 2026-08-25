// Store minúsculo tipo pub/sub. Nada de frameworks: nos basta para una SPA
// de una sola pantalla con un puñado de vistas.

const listeners = new Set();

export const state = {
  settings: {
    proxyUrl: localStorage.getItem("pb.proxyUrl") || "",
  },
  pocketcasts: {
    email: sessionStorage.getItem("pb.pc.email") || "",
    token: sessionStorage.getItem("pb.pc.token") || "",
    status: sessionStorage.getItem("pb.pc.token") ? "connected" : "disconnected", // disconnected | connecting | connected | error
    error: "",
  },
  search: {
    type: "program",       // "program" | "episode"
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

export function getJob(id) {
  return state.jobs.get(id) || { status: "idle", progress: 0, error: "" };
}

export function saveProxyUrl(url) {
  state.settings.proxyUrl = url.trim().replace(/\/+$/, "");
  localStorage.setItem("pb.proxyUrl", state.settings.proxyUrl);
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
  setPocketCasts({ token: "", email: "", status: "disconnected", error: "" });
}
