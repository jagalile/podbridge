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
