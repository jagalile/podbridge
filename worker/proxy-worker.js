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
 * ajustar las funciones `parseProgramCards` / `parseEpisodeCards` /
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
        case "GET /ivoox/image":
          return handleImageProxy(url, env);
        case "GET /ivoox/raw":
          return handleRaw(url, env);
        case "POST /pocketcasts/login":
          return handlePocketCastsLogin(request, env);
        case "POST /pocketcasts/upload":
          return handlePocketCastsUpload(request, env);
        case "POST /pocketcasts/upload-image":
          return handlePocketCastsUploadImage(request, env);
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
// Helpers de scraping compartidos
//
// iVoox mezcla dos generaciones de plantillas: las páginas de resultados de
// búsqueda (`_sw_..._1.html`) son HTML "clásico" con microdatos `itemprop`,
// mientras que las páginas de programa/episodio son una SPA Nuxt con muchos
// enlaces RELATIVOS (`/episodio.html` en vez de `https://www.ivoox.com/...`).
// Todo lo de aquí abajo está verificado contra HTML real de iVoox (agosto
// 2026) usando el propio endpoint /ivoox/raw de este Worker.
// ---------------------------------------------------------------------------

const IVOOX_ORIGIN = "https://www.ivoox.com";

function resolveUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return IVOOX_ORIGIN + (href.startsWith("/") ? href : `/${href}`);
}

/**
 * Las imágenes vienen servidas por un resizer
 * (img-static.ivoox.com/index.php?w=77&h=77&url=<imagen-real-XXL>) que las
 * entrega en miniatura. La imagen real en alta resolución está en el propio
 * parámetro `url=`, así que la extraemos en vez de usar el thumbnail.
 */
function upgradeImage(rawSrc) {
  if (!rawSrc) return null;
  const decoded = decodeHtmlEntities(rawSrc);
  try {
    const u = new URL(resolveUrl(decoded));
    if (u.hostname === "img-static.ivoox.com") {
      const real = u.searchParams.get("url");
      if (real) return real;
    }
    return u.href;
  } catch {
    return decoded;
  }
}

// Tabla de entidades HTML con nombre más comunes en texto en español (los
// campos meta description de iVoox suelen traer las tildes así en vez de
// UTF-8 directo). Las numéricas (&#237; / &#x00ed;) se resuelven aparte.
const NAMED_ENTITIES = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü",
  iexcl: "¡", iquest: "¿", ordf: "ª", ordm: "º", middot: "·",
  laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…",
};

function decodeHtmlEntitiesOnce(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent) => {
    if (ent[0] === "#") {
      const isHex = ent[1] === "x" || ent[1] === "X";
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ent] ?? match;
  });
}

/** iVoox a veces codifica dos veces (&amp;iacute; en vez de í), de ahí el doble paso. */
function decodeHtmlEntities(str) {
  return decodeHtmlEntitiesOnce(decodeHtmlEntitiesOnce(str));
}

function parseDurationToSeconds(str) {
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

const ORIGINALS_RE = /mini-badge-originals|ivoox\s*originals?/i;

// ---------------------------------------------------------------------------
// Tarjetas de PROGRAMA (páginas de búsqueda `_sw_..._1.html`)
//
// Cada resultado vive en un bloque `class="... modulo-type-programa"` con
// microdatos `itemprop` (nombre/descripción/url) y una imagen "lozad"
// (lazy-load) en el atributo `data-src`.
// ---------------------------------------------------------------------------

function splitCards(html, marker, maxLen = 4000) {
  const cards = [];
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const next = html.indexOf(marker, idx + marker.length);
    const end = Math.min(html.length, next === -1 ? idx + maxLen : Math.min(next, idx + maxLen));
    cards.push(html.slice(idx, end));
    idx = next;
  }
  return cards;
}

function parseProgramCards(html) {
  const results = [];
  for (const chunk of splitCards(html, "modulo-type-programa")) {
    const nameM = chunk.match(/itemprop="name"\s+content="([^"]+)"/);
    const urlM = chunk.match(/itemprop="url"\s+content="([^"]+)"/);
    if (!nameM || !urlM) continue; // bloque que no era realmente una tarjeta de programa

    const descM = chunk.match(/itemprop="description"\s+content="([^"]*)"/);
    const imgM = chunk.match(/<img[^>]*data-src="([^"]+)"[^>]*class="main[^"]*"/);
    const idM = urlM[1].match(/_sq_f(\d+)/);

    results.push({
      id: `program-${idM ? idM[1] : urlM[1]}`,
      type: "program",
      title: decodeHtmlEntities(nameM[1]),
      url: urlM[1],
      image: imgM ? upgradeImage(imgM[1]) : null,
      isOriginal: ORIGINALS_RE.test(chunk),
      // No hay un "autor" limpio en la tarjeta de búsqueda; usamos el
      // arranque de la descripción del programa como subtítulo.
      author: descM ? decodeHtmlEntities(descM[1]).slice(0, 100).trim() : "",
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tarjetas de EPISODIO (páginas de programa, SPA Nuxt)
//
// Por episodio hay tres `<a>` con el mismo href (relativo): la miniatura,
// el título (clase con "text-truncate") y el botón de play, cuya clase es
// "round-play btn-primary" en episodios libres y "round-play btn-fans" en
// los exclusivos de pago (programa de "Fans" de iVoox) — es la señal más
// fiable de exclusividad, más fiable que buscar la palabra "exclusivo".
// La duración va justo después del botón de play, en texto plano HH:MM:SS.
// Entre el título y el botón de play van también, en este orden, la
// descripción completa (`class="description mb-05"`) y la fecha en
// formato relativo de iVoox ("Hoy", "Ayer"…, `class="...text-nowrap"`) —
// iVoox no expone aquí una fecha absoluta (dd/mm/aaaa), solo esta relativa.
// ---------------------------------------------------------------------------

function parseEpisodeCards(html) {
  const titleRe = /<a\s+href="([^"]+)"\s+class="font-size-14[^"]*text-truncate[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/g;
  const playRe = /<a\s+href="([^"]+)"\s+class="round-play\s+(btn-fans|btn-primary)"/g;
  const imgTagPattern = '<img[^>]+src="([^"]+)"[^>]+alt="([^"]*)"';
  const dateRe = /class="[^"]*text-gray[^"]*text-nowrap[^"]*"[^>]*>\s*([^<]{1,40}?)\s*<\/span>/g;

  // href -> { isExclusive, duration, index } a partir del botón de play
  // (puede estar lejos del título si la descripción del episodio es larga,
  // así que se resuelve por separado y se cruza por href, no por cercanía).
  const playInfo = new Map();
  let pm;
  while ((pm = playRe.exec(html))) {
    const after = html.slice(pm.index, pm.index + 400);
    const durM = after.match(/class="text-gray font-size-11"[^>]*>\s*([\d:]+)\s*</);
    playInfo.set(pm[1], {
      isExclusive: pm[2] === "btn-fans",
      duration: durM ? parseDurationToSeconds(durM[1]) : null,
      index: pm.index,
    });
  }

  const episodes = [];
  const seen = new Set();
  let tm;
  while ((tm = titleRe.exec(html))) {
    const href = tm[1];
    if (seen.has(href)) continue;
    seen.add(href);

    // La miniatura del episodio queda justo antes de su título en el HTML.
    const before = html.slice(Math.max(0, tm.index - 700), tm.index);
    const imgMatches = [...before.matchAll(new RegExp(imgTagPattern, "g"))];
    const lastImg = imgMatches[imgMatches.length - 1];

    const info = playInfo.get(href) || {};
    // Descripción y fecha viven entre el título y el botón de play de este
    // mismo episodio; si no se localiza el botón, se acota a una ventana
    // razonable para no arrastrar contenido del episodio siguiente.
    const between = html.slice(tm.index, info.index ?? tm.index + 3000);
    const descM = between.match(/class="description mb-05"[^>]*>([\s\S]*?)<\/div>/);
    const dateMatches = [...between.matchAll(dateRe)];
    const lastDate = dateMatches[dateMatches.length - 1];

    const idMatch = href.match(/_rf_(\d+)/);
    const isExclusive = !!info.isExclusive;
    const absoluteUrl = resolveUrl(href);
    const title = decodeHtmlEntities(tm[2].trim()) || (lastImg ? decodeHtmlEntities(lastImg[2]) : href);

    episodes.push({
      id: `episode-${idMatch ? idMatch[1] : href}`,
      type: "episode",
      title,
      url: absoluteUrl,
      image: lastImg ? upgradeImage(lastImg[1]) : null,
      isOriginal: false, // se rellena por el llamante con el dato del programa
      isExclusive,
      date: lastDate ? decodeHtmlEntities(lastDate[1].trim()) : null,
      duration: info.duration ?? null,
      description: descM ? formatDescription(descM[1]) : "",
      downloadUrl: isExclusive ? null : absoluteUrl,
    });
  }
  return episodes;
}

/** Colapsa espacios dentro de cada párrafo pero conserva los saltos entre ellos. */
function formatDescription(raw) {
  return decodeHtmlEntities(raw)
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function parseProgramInfo(html, programUrl) {
  const breadcrumbM = html.match(
    /aria-current="page"\s+class="nuxt-link-exact-active nuxt-link-active"[^>]*>\s*([^<]+?)\s*<\/a>/,
  );
  const h1M = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
  const title = breadcrumbM
    ? decodeHtmlEntities(breadcrumbM[1].trim())
    : h1M
      ? decodeHtmlEntities(h1M[1].replace(/<[^>]+>/g, "").trim())
      : programUrl;

  const ogImageM = html.match(/property="og:image"\s+content="([^"]+)"/i);
  const ogDescM = html.match(/property="og:description"\s+content="([^"]*)"/i);

  return {
    title,
    image: ogImageM ? upgradeImage(ogImageM[1]) : null,
    author: "",
    description: ogDescM ? decodeHtmlEntities(ogDescM[1]).trim() : "",
    isOriginal: ORIGINALS_RE.test(html),
    url: programUrl,
  };
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
  const programs = parseProgramCards(html);

  if (type === "program") {
    return json({ results: programs, sourceUrl: searchUrl }, env);
  }

  // iVoox no indexa episodios sueltos por palabra clave (solo programas):
  // buscamos los programas más afines y filtramos sus episodios cuyo
  // título contiene la búsqueda. Es una aproximación razonable, no una
  // búsqueda global de episodios — lo dejamos documentado en el README.
  const candidates = programs.slice(0, 5);
  const lowerQuery = q.toLowerCase();

  const perProgram = await Promise.all(
    candidates.map(async (program) => {
      try {
        const pRes = await fetchIvoox(program.url);
        const pHtml = await pRes.text();
        return parseEpisodeCards(pHtml).map((ep) => ({
          ...ep,
          program: program.title,
          isOriginal: program.isOriginal,
        }));
      } catch {
        return [];
      }
    }),
  );

  const results = perProgram
    .flat()
    .filter((ep) => ep.title.toLowerCase().includes(lowerQuery))
    .slice(0, 30);

  return json({ results, sourceUrl: searchUrl }, env);
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
  const episodes = parseEpisodeCards(html).map((ep) => ({
    ...ep,
    program: info.title,
    isOriginal: info.isOriginal,
  }));

  return json({ info, episodes }, env);
}

// ---------------------------------------------------------------------------
// GET /ivoox/audio?url=  → retransmite el mp3 real de un episodio
// ---------------------------------------------------------------------------

async function handleAudio(url, env) {
  const episodeUrl = url.searchParams.get("url");
  if (!episodeUrl) return errorResponse("Falta el parámetro url", env, 400);

  const audioUrl = resolveAudioUrl(episodeUrl);
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
 * El reproductor de iVoox resuelve el mp3 real a partir del id numérico del
 * episodio (el mismo que aparece en la URL como "_rf_<id>") con un patrón
 * fijo: /listen_mn_<id>_1.mp3, que hace un par de redirecciones 302 hasta el
 * CDN (Triton Digital) y devuelve el audio. Verificado contra HTML/tráfico
 * real de iVoox (agosto 2026) — si esto deja de funcionar, es el primer
 * sitio donde mirar (junto con /ivoox/raw?url=<episodio> para reinspeccionar).
 */
function resolveAudioUrl(episodeUrl) {
  const m = episodeUrl.match(/_rf_(\d+)/);
  return m ? `https://www.ivoox.com/listen_mn_${m[1]}_1.mp3` : null;
}

// ---------------------------------------------------------------------------
// GET /ivoox/image?url=  → retransmite una portada (programa o episodio)
//
// Las imágenes de iVoox suelen dejarse "hotlinkear" sin problema, pero no
// hay garantía de que manden cabeceras CORS pensadas para un origen externo
// como el de GitHub Pages — se retransmiten por aquí para no depender de
// ello (y de paso sirve para subir la portada a Pocket Casts sin que el
// navegador tenga que descargarla directamente de iVoox).
// ---------------------------------------------------------------------------

async function handleImageProxy(url, env) {
  const target = url.searchParams.get("url");
  if (!target) return errorResponse("Falta el parámetro url", env, 400);

  const res = await fetch(target, { headers: BROWSER_HEADERS });
  if (!res.ok || !res.body) {
    return errorResponse(`iVoox respondió ${res.status} al descargar la imagen`, env, 502);
  }

  const headers = new Headers(corsHeaders(env));
  headers.set("Content-Type", res.headers.get("Content-Type") || "image/jpeg");
  const len = res.headers.get("Content-Length");
  if (len) headers.set("Content-Length", len);

  return new Response(res.body, { status: 200, headers });
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

/**
 * El fichero llega como cuerpo crudo de la petición (no FormData): así se
 * puede retransmitir en streaming directamente al PUT de S3 sin bufferizar
 * el episodio entero en memoria del Worker. Con episodios largos (varias
 * horas → cientos de MB) bufferizar todo el fichero podía agotar el límite
 * de memoria del Worker y dejar la subida colgada sin ningún error visible.
 */
async function handlePocketCastsUpload(request, env) {
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const title = url.searchParams.get("title") || "Episodio";
  const contentType = url.searchParams.get("contentType") || "audio/mpeg";
  const size = Number(request.headers.get("Content-Length") || 0);

  if (!token) return errorResponse("Falta el token de Pocket Casts", env, 401);
  if (!request.body || !size) return errorResponse("Falta el fichero de audio", env, 400);

  const id = crypto.randomUUID();
  const hasImage = url.searchParams.get("hasImage") === "1";

  const requestBody = encodeFileUploadRequest({ uuid: id, title, size, contentType, hasImage });

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

  // Streaming directo: el cuerpo de la petición entrante se retransmite tal
  // cual al PUT de S3, sin pasar por memoria como un buffer completo.
  const putRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(size) },
    body: request.body,
    duplex: "half",
  });
  if (!putRes.ok) {
    return errorResponse(`Falló la subida del audio al almacenamiento de Pocket Casts (${putRes.status})`, env, 502);
  }

  return json({ ok: true, uuid: id, title }, env);
}

/**
 * Sube la portada de un episodio ya subido a Archivos. Es un segundo paso
 * independiente, atado al mismo `uuid` que devolvió /pocketcasts/upload —
 * por eso hay que pasarlo por query string aquí. Si esto falla, no se
 * reintenta ni bloquea nada: el audio ya está subido, la portada es solo
 * un extra (Pocket Casts pondrá su icono por defecto).
 */
async function handlePocketCastsUploadImage(request, env) {
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const uuid = url.searchParams.get("uuid");
  const contentType = url.searchParams.get("contentType") || "image/jpeg";
  const size = Number(request.headers.get("Content-Length") || 0);

  if (!token) return errorResponse("Falta el token de Pocket Casts", env, 401);
  if (!uuid) return errorResponse("Falta el uuid del fichero", env, 400);
  if (!request.body || !size) return errorResponse("Falta la imagen", env, 400);

  const requestBody = encodeImageUploadRequest({ uuid, size, contentType });

  const uploadReqRes = await fetch("https://api.pocketcasts.com/files/upload/image", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: requestBody,
  });
  if (!uploadReqRes.ok) {
    return errorResponse(`Pocket Casts rechazó la subida de portada (${uploadReqRes.status})`, env, uploadReqRes.status);
  }

  const responseBytes = new Uint8Array(await uploadReqRes.arrayBuffer());
  const presignedUrl = decodeImageUploadResponseUrl(responseBytes);
  if (!presignedUrl) {
    return errorResponse("Pocket Casts no devolvió una URL de subida de portada válida", env, 502);
  }

  const putRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(size) },
    body: request.body,
    duplex: "half",
  });
  if (!putRes.ok) {
    return errorResponse(`Falló la subida de la portada (${putRes.status})`, env, 502);
  }

  return json({ ok: true, uuid }, env);
}

// --- Protobuf mínimo, a mano, solo para los mensajes que necesitamos ---
// (Files_FileUploadRequest/Response y Files_ImageUploadRequest/Response,
// campos según el endpoint reverse-engineered de la app oficial de Pocket
// Casts. Field numbers verificados contra su fuente Swift/protobuf.)

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

function encodeFileUploadRequest({ uuid, title, size, contentType, hasImage }) {
  return concatBytes(
    encodeStringField(1, uuid),
    encodeStringField(2, title),
    encodeVarintFieldMsg(3, size),
    encodeStringField(4, contentType),
    // Campo 7 = hasCustomImage_p (bool). Hay que avisar aquí de que se va a
    // subir una portada — la petición de subida de imagen (más abajo) es un
    // paso aparte, ligado al mismo uuid, pero Pocket Casts necesita saber
    // de antemano que la va a esperar.
    hasImage ? encodeVarintFieldMsg(7, 1) : new Uint8Array(),
  );
}

function encodeImageUploadRequest({ uuid, size, contentType }) {
  return concatBytes(
    encodeStringField(1, uuid),
    encodeVarintFieldMsg(2, size),
    encodeStringField(3, contentType),
  );
}

/** Lee un mensaje protobuf de respuesta y devuelve el string de `fieldNum`. */
function decodeProtobufStringField(bytes, fieldNum) {
  let pos = 0;
  let value = null;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const num = tag >> 3;
    const wireType = tag & 7;

    if (wireType === 0) {
      const [, next] = readVarint(bytes, pos);
      pos = next;
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(bytes, pos);
      pos = afterLen;
      const slice = bytes.slice(pos, pos + len);
      pos += len;
      if (num === fieldNum) value = new TextDecoder().decode(slice);
    } else {
      break; // wire type no soportado (no debería aparecer en estos mensajes)
    }
  }
  return value;
}

// Files_FileUploadResponse: campo 1 = uuid, campo 2 = url.
const decodeFileUploadResponseUrl = (bytes) => decodeProtobufStringField(bytes, 2);
// Files_ImageUploadResponse: campo 1 = url (mensaje más simple, sin uuid).
const decodeImageUploadResponseUrl = (bytes) => decodeProtobufStringField(bytes, 1);

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
