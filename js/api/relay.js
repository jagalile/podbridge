// Cliente del servicio de relevo externo (fuera de Cloudflare), solo para
// episodios grandes cuya subida a través del Worker no es fiable — ver
// README → "Episodios muy grandes". Se despliega aparte (ver
// /relay-service) en una plataforma sin el límite de tamaño de petición
// saliente que tiene Cloudflare Workers.
//
// Este servicio nunca ve el email, la contraseña ni el token de Pocket
// Casts: solo la URL pública del mp3 en iVoox y una URL de subida ya
// autorizada por Pocket Casts (de un solo uso, ligada a un fichero
// concreto) — lo mínimo posible para hacer su trabajo.

class RelayNotConfiguredError extends Error {
  constructor() {
    super("Configura la URL de tu servicio de relevo en Ajustes para poder subir este episodio.");
    this.name = "RelayNotConfiguredError";
  }
}

class RelayRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RelayRequestError";
    this.status = status;
  }
}

/**
 * @param {{audioUrl:string, uploadUrl:string, contentType:string, size:number}} payload
 * @param {string} relayUrl
 * @param {string} relaySecret
 * @param {AbortSignal} [signal]
 */
export async function relayUpload({ audioUrl, uploadUrl, contentType, size }, relayUrl, relaySecret, signal) {
  if (!relayUrl) throw new RelayNotConfiguredError();

  const res = await fetch(`${relayUrl.replace(/\/+$/, "")}/relay-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Relay-Secret": relaySecret || "" },
    body: JSON.stringify({ audioUrl, uploadUrl, contentType, size }),
    signal,
  });

  if (!res.ok) {
    let message = `El servicio de relevo respondió ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch { /* respuesta no era JSON, nos quedamos con el mensaje genérico */ }
    throw new RelayRequestError(message, res.status);
  }
  return res.json();
}

/**
 * Comprueba si el servicio de relevo configurado responde (GET /health).
 * No lanza si falla. El plan gratuito de Render "duerme" el servicio tras
 * ~15 min sin uso y tarda 30-50s en arrancar de nuevo — de ahí el timeout
 * largo (60s) y que se devuelva cuánto ha tardado: un tiempo alto en un
 * ping que SÍ acaba respondiendo es la única pista disponible de que
 * estaba dormido y este ping lo ha despertado (no hay ninguna API para
 * preguntárselo directamente).
 *
 * Cuando el ping falla, `reason` distingue tres casos que, si no, se
 * verían todos igual de "no responde":
 *   - "timeout": se agotaron los 60s sin respuesta — probablemente
 *     estaba dormido y no ha llegado a arrancar a tiempo, o está caído
 *     de verdad. No hay forma de saber cuál de las dos sin reintentar.
 *   - "network": ha fallado casi al instante, antes de que diera tiempo
 *     a nada — típico de una URL mal escrita, DNS que no resuelve, o el
 *     servicio directamente inalcanzable (no es un "está despertando").
 *   - "http": ha respondido, pero con un error (interesante: el
 *     servicio SÍ está despierto, solo que algo va mal en él).
 *
 * @param {string} url
 * @returns {Promise<{ok:boolean, ms:number, reason?:"timeout"|"network"|"http", status?:number}>}
 */
export async function pingRelay(url) {
  const started = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(60_000) });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, reason: "http", status: res.status };
    const data = await res.json();
    return { ok: !!data.ok, ms, reason: data.ok ? undefined : "http", status: res.status };
  } catch (err) {
    const ms = Date.now() - started;
    // AbortSignal.timeout() aborta con un DOMException "TimeoutError" —
    // se distingue así de un fallo de red normal (fetch lanza un
    // TypeError, p. ej. "Failed to fetch", para DNS/CORS/conexión rehusada).
    const reason = err?.name === "TimeoutError" ? "timeout" : "network";
    return { ok: false, ms, reason };
  }
}
