/**
 * PodBridge — Worker puente entre el frontend estático (GitHub Pages) y
 * los dos servicios de terceros que no se pueden hablar directamente desde
 * un navegador:
 *
 *   · iVoox    — no tiene API JSON pública para buscar/listar. Este Worker
 *                hace scraping de sus páginas HTML públicas.
 *   · Pocket Casts — API privada (api.pocketcasts.com) que usa protobuf
 *                para la subida de Archivos y no envía cabeceras CORS
 *                pensadas para orígenes externos.
 *
 * IMPORTANTE sobre el scraping de iVoox: iVoox no publica un contrato
 * estable para estas páginas. Las funciones de esta sección están escritas
 * para ser lo más tolerantes posible (basadas en patrones de URL reales:
 * los programas usan "_sq_f<id>" y los episodios "_rf_<id>"), pero si iVoox
 * cambia su HTML esto puede dejar de encontrar resultados. Usa el endpoint
 * de depuración `/ivoox/raw?url=...` para inspeccionar el HTML real y
 * ajustar las funciones `parseSearchResults` / `parseProgramPage` /
 * `resolveAudioUrl` de este archivo.
 *
 * Despliegue: `wrangler deploy` desde esta carpeta (ver README).
 */

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env) },
  });
}

function errorResponse(message, env, status = 500) {
  return json({ error: message }, env, status);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /ivoox/search":
          return handleSearch(url, env);
        case "GET /ivoox/program":
          return handleProgram(url, env);
        case "GET /ivoox/audio":
          return handleAudio(url, env);
        case "GET /ivoox/raw":
          return handleRaw(url, env);
        case "POST /pocketcasts/login":
          return handlePocketCastsLogin(request, env);
        case "POST /pocketcasts/upload":
          return handlePocketCastsUpload(request, env);
        default:
          return errorResponse("Not found", env, 404);
      }
    } catch (err) {
      return errorResponse(err.message || "Error interno del Worker", env, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// iVoox — cabeceras "de navegador" para evitar bloqueos básicos anti-bot
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "es-ES,es;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchIvoox(targetUrl, extraHeaders = {}) {
  const res = await fetch(targetUrl, { headers: { ...BROWSER_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`iVoox respondió ${res.status} para ${targetUrl}`);
  return res;
}

const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

function slugify(text) {
  return text
    .normalize("NFD").replace(COMBINING_DIACRITICS, "") // quita acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// GET /ivoox/search?q=&type=program|episode
// ---------------------------------------------------------------------------

async function handleSearch(url, env) {
  const q = url.searchParams.get("q");
  const type = url.searchParams.get("type") === "episode" ? "episode" : "program";
  if (!q) return errorResponse("Falta el parámetro q", env, 400);

  const searchUrl = `https://www.ivoox.com/podcast-${slugify(q)}_sw_1_1_1.html`;
  const res = await fetchIvoox(searchUrl);
  const html = await res.text();

  const allCards = parseSearchResults(html, searchUrl);
  const results = allCards.filter((c) => c.type === type);

  return json({ results, sourceUrl: searchUrl }, env);
}

/**
 * Extrae tarjetas de resultado (programa o episodio) de una página HTML de
 * iVoox. Estrategia: recorrer todos los <a href="https://www.ivoox.com/...">
 * y clasificarlos por el patrón de la URL, que es la parte más estable del
 * sitio. El título/imagen se leen del propio bloque del enlace cuando es
 * posible; si no se encuentran, se dejan vacíos en vez de fallar.
 */
function parseSearchResults(html, baseUrl) {
  const cards = [];
  const seen = new Set();

  // Bloque "anchor + hasta 600 caracteres siguientes" para poder buscar una
  // <img> y un texto de título cercanos sin depender de una librería DOM.
  const anchorRe = /<a\b[^>]*href="(https:\/\/(?:www|us)\.ivoox\.com\/[^"?#]+\.html)"[^>]*>([\s\S]{0,600}?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html))) {
    const [, href, innerBlock] = match;
    if (seen.has(href)) continue;

    const type = classifyIvooxUrl(href);
    if (!type) continue; // enlace que no es ni programa ni episodio (menú, categoría, etc.)
    seen.add(href);

    const context = html.slice(Math.max(0, match.index - 400), match.index + match[0].length + 200);
    cards.push(buildCard(type, href, innerBlock, context));
  }

  return cards;
}

function classifyIvooxUrl(href) {
  if (/_sq_f\d+/.test(href)) return "program";
  if (/_rf_\d+/.test(href)) return "episode";
  return null;
}

function buildCard(type, href, innerBlock, context) {
  const title = extractTitle(innerBlock, href);
  const image = extractImage(innerBlock) || extractImage(context);
  const isOriginal = /ivoox\s*originals?/i.test(context);
  const isExclusive = type === "episode" && /exclusiv/i.test(context);
  const id = (href.match(/_(?:sq_f|rf_)(\d+)/) || [, href])[1];

  const base = { id: `${type}-${id}`, type, title, url: href, image, isOriginal };
  if (type === "program") {
    return { ...base, author: extractAuthor(context) };
  }
  return {
    ...base,
    program: extractAuthor(context),
    isExclusive,
    date: extractDate(context),
    duration: extractDuration(context),
    downloadUrl: isExclusive ? null : href, // se resuelve al mp3 real en /ivoox/audio bajo demanda
  };
}

function extractTitle(innerBlock, fallbackHref) {
  const stripped = innerBlock.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (stripped) return decodeHtmlEntities(stripped);
  const slug = fallbackHref.split("/").pop().replace(/\.html$/, "");
  return decodeHtmlEntities(slug.replace(/[-_]/g, " "));
}

function extractImage(block) {
  const m = block && block.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : null;
}

function extractAuthor(context) {
  const m = context.match(/de\s+([A-ZÁÉÍÓÚÑ][^<>"]{2,40})/);
  return m ? decodeHtmlEntities(m[1].trim()) : "";
}

function extractDate(context) {
  const m = context.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
  return m ? m[1] : null;
}

function extractDuration(context) {
  const m = context.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  if (!m) return null;
  const parts = m[1].split(":").map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

function decodeHtmlEntities(str) {
  return str
    .replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&nbsp;", " ");
}

// ---------------------------------------------------------------------------
// GET /ivoox/program?url=  → info del programa + lista de episodios
// ---------------------------------------------------------------------------

async function handleProgram(url, env) {
  const programUrl = url.searchParams.get("url");
  if (!programUrl) return errorResponse("Falta el parámetro url", env, 400);

  const res = await fetchIvoox(programUrl);
  const html = await res.text();

  const info = parseProgramInfo(html, programUrl);
  const episodes = parseSearchResults(html, programUrl).filter((c) => c.type === "episode");

  return json({ info, episodes }, env);
}

function parseProgramInfo(html, programUrl) {
  const titleMatch = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, "").trim()) : programUrl;
  const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  const isOriginal = /ivoox\s*originals?/i.test(html.slice(0, 4000));

  return {
    title,
    image: ogImage ? ogImage[1] : null,
    author: extractAuthor(html.slice(0, 4000)),
    isOriginal,
    url: programUrl,
  };
}

// ---------------------------------------------------------------------------
// GET /ivoox/audio?url=  → retransmite el mp3 real de un episodio
// ---------------------------------------------------------------------------

async function handleAudio(url, env) {
  const episodeUrl = url.searchParams.get("url");
  if (!episodeUrl) return errorResponse("Falta el parámetro url", env, 400);

  const audioUrl = await resolveAudioUrl(episodeUrl);
  if (!audioUrl) {
    return errorResponse(
      "No se ha podido resolver el audio de este episodio (puede ser exclusivo o iVoox ha cambiado su web).",
      env, 422,
    );
  }

  const audioRes = await fetch(audioUrl, {
    headers: { ...BROWSER_HEADERS, Referer: episodeUrl },
  });
  if (!audioRes.ok || !audioRes.body) {
    return errorResponse(`iVoox respondió ${audioRes.status} al descargar el audio`, env, 502);
  }

  const headers = new Headers(corsHeaders(env));
  headers.set("Content-Type", audioRes.headers.get("Content-Type") || "audio/mpeg");
  const len = audioRes.headers.get("Content-Length");
  if (len) headers.set("Content-Length", len);

  return new Response(audioRes.body, { status: 200, headers });
}

/**
 * Punto más frágil del scraper: la URL mp3 real no siempre viene en el HTML
 * estático de la página del episodio (iVoox puede cargarla de forma
 * dinámica). Se intenta, en orden:
 *   1. Un enlace directo a un .mp3 en el HTML.
 *   2. Un campo tipo "file"/"audio_url"/"mp3" dentro de un bloque JSON
 *      embebido (JSON-LD o variables de estado inline).
 * Si ninguna de las dos aparece, se devuelve null y el frontend lo trata
 * como "no disponible" (ver README → sección de mantenimiento del scraper).
 */
async function resolveAudioUrl(episodeUrl) {
  const res = await fetchIvoox(episodeUrl);
  const html = await res.text();

  const direct = html.match(/https?:\/\/[^"'\s]+\.mp3(?:\?[^"'\s]*)?/i);
  if (direct) return direct[0];

  const jsonField = html.match(/"(?:file|audio_url|mp3|streamUrl)"\s*:\s*"([^"]+\.mp3[^"]*)"/i);
  if (jsonField) return jsonField[1].replace(/\\\//g, "/");

  return null;
}

// ---------------------------------------------------------------------------
// GET /ivoox/raw?url=  → HTML crudo, solo para depurar el scraper
// ---------------------------------------------------------------------------

async function handleRaw(url, env) {
  const target = url.searchParams.get("url");
  if (!target) return errorResponse("Falta el parámetro url", env, 400);
  const res = await fetchIvoox(target);
  const html = await res.text();
  return new Response(html, { headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders(env) } });
}

// ---------------------------------------------------------------------------
// Pocket Casts — login
// ---------------------------------------------------------------------------

async function handlePocketCastsLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return errorResponse("Email y contraseña son obligatorios", env, 400);

  const res = await fetch("https://api.pocketcasts.com/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, scope: "webplayer" }),
  });

  if (!res.ok) {
    return errorResponse(
      res.status === 401 ? "Email o contraseña incorrectos" : `Pocket Casts respondió ${res.status}`,
      env, res.status,
    );
  }
  const data = await res.json();
  return json({ token: data.token }, env);
}

// ---------------------------------------------------------------------------
// Pocket Casts — subida a Archivos (protobuf + S3 presigned URL)
// ---------------------------------------------------------------------------

async function handlePocketCastsUpload(request, env) {
  const form = await request.formData();
  const token = form.get("token");
  const title = form.get("title") || "Episodio";
  const contentType = form.get("contentType") || "audio/mpeg";
  const file = form.get("file");

  if (!token) return errorResponse("Falta el token de Pocket Casts", env, 401);
  if (!file) return errorResponse("Falta el fichero de audio", env, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = crypto.randomUUID();

  const requestBody = encodeFileUploadRequest({
    uuid: id,
    title: String(title),
    size: bytes.byteLength,
    contentType: String(contentType),
  });

  const uploadReqRes = await fetch("https://api.pocketcasts.com/files/upload/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: requestBody,
  });

  if (!uploadReqRes.ok) {
    return errorResponse(`Pocket Casts rechazó la solicitud de subida (${uploadReqRes.status})`, env, uploadReqRes.status);
  }

  const responseBytes = new Uint8Array(await uploadReqRes.arrayBuffer());
  const presignedUrl = decodeFileUploadResponseUrl(responseBytes);
  if (!presignedUrl) {
    return errorResponse("Pocket Casts no devolvió una URL de subida válida", env, 502);
  }

  const putRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!putRes.ok) {
    return errorResponse(`Falló la subida del audio al almacenamiento de Pocket Casts (${putRes.status})`, env, 502);
  }

  return json({ ok: true, uuid: id, title }, env);
}

// --- Protobuf mínimo, a mano, solo para los dos mensajes que necesitamos ---
// (Files_FileUploadRequest / Files_FileUploadResponse, campos según el
// endpoint reverse-engineered de la app oficial de Pocket Casts.)

function encodeVarint(num) {
  const bytes = [];
  let n = BigInt(num);
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return new Uint8Array(bytes);
}

function encodeField(fieldNum, wireType, payload) {
  const tag = encodeVarint((fieldNum << 3) | wireType);
  return concatBytes(tag, payload);
}

function encodeStringField(fieldNum, str) {
  const strBytes = new TextEncoder().encode(str);
  return encodeField(fieldNum, 2, concatBytes(encodeVarint(strBytes.length), strBytes));
}

function encodeVarintFieldMsg(fieldNum, num) {
  return encodeField(fieldNum, 0, encodeVarint(num));
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function encodeFileUploadRequest({ uuid, title, size, contentType }) {
  return concatBytes(
    encodeStringField(1, uuid),
    encodeStringField(2, title),
    encodeVarintFieldMsg(3, size),
    encodeStringField(4, contentType),
  );
}

/** Lee el mensaje de respuesta y devuelve el string del campo 2 (URL). */
function decodeFileUploadResponseUrl(bytes) {
  let pos = 0;
  let url = null;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const fieldNum = tag >> 3;
    const wireType = tag & 7;

    if (wireType === 0) {
      const [, next] = readVarint(bytes, pos);
      pos = next;
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(bytes, pos);
      pos = afterLen;
      const slice = bytes.slice(pos, pos + len);
      pos += len;
      if (fieldNum === 2) url = new TextDecoder().decode(slice);
    } else {
      break; // wire type no soportado (no debería aparecer en este mensaje)
    }
  }
  return url;
}

function readVarint(bytes, pos) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  for (;;) {
    const b = bytes[p++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [Number(result), p];
}
