// Cliente HTTP hacia el Worker puente (ver /worker). Todo lo que necesita
// saltarse CORS, hablar HTML-scraping o protobuf pasa por aquí.

import { state } from "../state.js";

class ProxyNotConfiguredError extends Error {
  constructor() {
    super("Configura primero la URL de tu Worker en Ajustes.");
    this.name = "ProxyNotConfiguredError";
  }
}

export class ProxyRequestError extends Error {
  constructor(message, status, debug) {
    super(message);
    this.name = "ProxyRequestError";
    this.status = status;
    this.debug = debug;
  }
}

function baseUrl() {
  const url = state.settings.proxyUrl;
  if (!url) throw new ProxyNotConfiguredError();
  return url;
}

async function request(path, { method = "GET", body, headers = {}, signal } = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body,
    signal,
  });

  if (!res.ok) {
    let message = `El Worker respondió ${res.status}`;
    let debug;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
      debug = data?.debug;
    } catch { /* respuesta no era JSON, nos quedamos con el mensaje genérico */ }
    // El campo debug (cuando lo hay) nunca lleva nada sensible — solo
    // cabeceras/estado de diagnóstico — pero sí puede ser la única pista
    // real de qué ha pasado, así que se deja en la consola en vez de
    // perderse silenciosamente.
    if (debug) console.warn(`PodBridge: ${path} falló`, debug);
    throw new ProxyRequestError(message, res.status, debug);
  }
  return res;
}

export async function getJson(path, opts) {
  const res = await request(path, opts);
  return res.json();
}

export async function postJson(path, body, opts = {}) {
  const res = await request(path, {
    ...opts,
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** true si el Worker configurado en Ajustes responde. No lanza si falla. */
export async function pingWorker(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}

export { request };
