// Cliente HTTP hacia el Worker puente (ver /worker). Todo lo que necesita
// saltarse CORS, hablar HTML-scraping o protobuf pasa por aquí.

import { state } from "../state.js";

export class ProxyNotConfiguredError extends Error {
  constructor() {
    super("Configura primero la URL de tu Worker en Ajustes.");
    this.name = "ProxyNotConfiguredError";
  }
}

export class ProxyRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ProxyRequestError";
    this.status = status;
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
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch { /* respuesta no era JSON, nos quedamos con el mensaje genérico */ }
    throw new ProxyRequestError(message, res.status);
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

export { request };
