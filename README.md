# PodBridge

**Busca programas y episodios de iVoox, y súbelos directamente a tus
Archivos de Pocket Casts — sin descargar nada a mano, sin conversiones,
sin pasos intermedios.**

PodBridge es una herramienta personal, pensada para gente que sigue
podcasts en iVoox pero prefiere Pocket Casts como reproductor. Busca un
programa o un episodio, pulsa un botón y el audio (y su portada) aparecen
en tus Archivos de Pocket Casts, listos para escuchar en cualquier
dispositivo.

No es una app oficial de iVoox ni de Pocket Casts, ni tiene afiliación con
ninguna de las dos.

---

## Índice

- [Características](#características)
- [Cómo funciona (arquitectura)](#cómo-funciona-arquitectura)
- [Instalación y despliegue](#instalación-y-despliegue)
- [Uso](#uso)
- [Persistencia y seguridad](#persistencia-y-seguridad)
- [Cómo funciona el Worker por dentro](#cómo-funciona-el-worker-por-dentro)
- [Limitaciones y cosas a tener en cuenta](#limitaciones-y-cosas-a-tener-en-cuenta)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Licencia](#licencia)
- [Aviso de uso](#aviso-de-uso)

---

## Características

**Búsqueda**
- Buscador de programas de iVoox, con portada, insignia de iVoox
  Originals y descripción (con "Leer más" para la versión completa).
- Buscador de episodios sueltos por palabra clave (aproximado: busca
  entre los episodios de los programas más afines a la búsqueda — iVoox
  no indexa episodios individuales).
- Buscador propio *dentro* de la lista de episodios de un programa ya
  abierto, para encontrar uno concreto sin bajar a mano.

**Programas y episodios**
- Vista de programa con portada, descripción, enlace directo a iVoox
  (nueva pestaña) e insignia de iVoox Originals cuando corresponde.
- Lista de episodios con scroll infinito (cargan por páginas a medida
  que bajas, no solo la primera).
- Cada episodio muestra portada, fecha, duración y un botón de "más
  información" con la ficha completa (descripción entera, insignias,
  enlace a iVoox).
- Los episodios **exclusivos** (contenido de pago de iVoox) se
  identifican y quedan bloqueados: esta herramienta nunca los descarga.

**Descarga y subida**
- Un solo botón por episodio: el Worker descarga el audio de iVoox y lo
  sube a Archivos de Pocket Casts de servidor a servidor — el audio en sí
  nunca pasa por tu navegador ni por tu conexión. Funciona bien para la
  gran mayoría de episodios; los muy largos (varias horas, ~250+ MB)
  todavía pueden fallar — ver
  [Episodios muy grandes](#cómo-funciona-el-worker-por-dentro).
- Para esos episodios grandes, un botón adicional de "descargar mp3"
  (junto al de información) lo baja directo al navegador para que lo
  subas tú mismo desde la app de Pocket Casts — no depende del Worker
  para la parte que falla, así que siempre funciona.
- Sube también la portada del episodio como imagen personalizada del
  fichero en Pocket Casts (si falla, el episodio se sube igualmente, solo
  que sin portada propia).
- Se pueden lanzar varias descargas/subidas a la vez (no hay cola: cada
  episodio va por su cuenta) — un indicador en la cabecera muestra
  cuántas hay en curso y, al pasar el ratón o pulsarlo, el progreso
  individual de cada una.
- Si una descarga o subida se queda sin responder (red inestable, algo se
  cuelga a medio camino…), se detecta sola a los 45 segundos sin
  actividad y pasa a error lista para reintentar — y en cualquier
  momento se puede cancelar a mano pulsando el propio botón de progreso.
  Antes un atasco se quedaba así para siempre, sin más salida que
  recargar la página entera.

**Cuenta y estado**
- Conexión con Pocket Casts mediante email y contraseña; las
  credenciales viajan directas a tu propio Worker y de ahí a Pocket
  Casts, nunca a un servidor de terceros. La contraseña nunca se guarda
  en ningún sitio.
- "Recordarme en este dispositivo" (opcional): mantiene la sesión de
  Pocket Casts entre visitas sin volver a pedir la contraseña, con el
  token cifrado en el navegador — ver [Persistencia y seguridad](#persistencia-y-seguridad).
- Espacio usado en Archivos de Pocket Casts (barra con porcentaje, y
  cuánto ocupa cada episodio en su propia fila), para saber cuánto sitio
  te queda antes de que se llene.
- Indicador de estado combinado en la cabecera: al pasar el ratón o
  pulsarlo se ve el detalle del Worker y de Pocket Casts por separado —
  de un vistazo sabes cuál de los dos falla si algo no funciona.

**Favoritos e historial**
- Marca programas como favoritos con un toque (desde la tarjeta de
  búsqueda o desde la propia ficha del programa) y encuéntralos luego en
  la pestaña "Favoritos" del buscador, que además tiene su propio filtro
  por título para cuando la lista crece.
- Los episodios ya subidos se recuerdan entre sesiones: si vuelves más
  tarde, siguen marcados como subidos en vez de ofrecerte subirlos otra
  vez.
- Exportar/importar favoritos, historial y la URL del Worker como un
  archivo JSON, para hacer copia de seguridad o pasarlos a otro navegador
  — nunca incluye contraseñas ni el token de Pocket Casts.

**Interfaz**
- Diseño responsive (escritorio y móvil), con tema claro/oscuro
  automático según el sistema.
- Estados de carga (esqueletos), vacío y error cuidados en toda la app,
  con opción de reintentar.
- Aviso antes de cerrar o recargar la pestaña si hay una descarga o
  subida en curso.

---

## Cómo funciona (arquitectura)

GitHub Pages solo sirve ficheros estáticos (HTML/CSS/JS). Pero hacer
funcionar esta app de verdad requiere dos cosas que un navegador no puede
hacer por sí solo:

1. **Buscar en iVoox.** iVoox no tiene una API JSON pública — su búsqueda
   son páginas HTML normales, hay que descargarlas e interpretarlas
   (*scraping*), y su servidor no manda cabeceras CORS pensadas para que
   un origen externo (como `tu-usuario.github.io`) las lea con `fetch`.
2. **Subir a Pocket Casts.** Su API (`api.pocketcasts.com`) es privada,
   usa mensajes **protobuf** binarios para subir ficheros, y tampoco
   habilita CORS para orígenes de terceros.

La solución es un pequeño **Worker de Cloudflare** — gratis, tuyo, lo
despliegas tú — que hace de puente: el frontend estático en GitHub Pages
le habla a tu Worker, y tu Worker habla con iVoox y con Pocket Casts.

```
Navegador (GitHub Pages)
   │  búsqueda, progreso, ajustes
   ▼
Tu Worker (Cloudflare)
   │  parsea el HTML de iVoox ────────────▶  iVoox (scraping)
   │  habla el protobuf de Pocket Casts ──▶  Pocket Casts (API privada)
```

Cada usuario despliega **su propio Worker**: es una decisión de diseño,
no una limitación accidental. Así las credenciales de Pocket Casts pasan
siempre por infraestructura que tú controlas, nunca por un servidor
compartido con otros usuarios de la app.

---

## Instalación y despliegue

### 1. Desplegar el Worker

```bash
cd worker
npx wrangler login        # una vez, abre el navegador para autorizar
npx wrangler deploy
```

La primera vez, `wrangler` puede pedirte registrar un subdominio
`workers.dev` (gratis, di que sí) y verificar el email de tu cuenta de
Cloudflare si aún no lo has hecho. Al terminar te da una URL del tipo:

```
https://podbridge-proxy.tu-subdominio.workers.dev
```

Guárdala, la necesitas en el paso 3.

Opcional pero recomendado: una vez tengas la URL de tu GitHub Pages,
edita `worker/wrangler.toml` y cambia `ALLOWED_ORIGIN = "*"` por tu
dominio real (`https://tu-usuario.github.io`), y vuelve a desplegar.

### 2. Publicar el frontend en GitHub Pages

Sube este repositorio a GitHub y activa Pages en
**Settings → Pages → Build and deployment → GitHub Actions**. El workflow
en `.github/workflows/deploy.yml` publica la raíz del repo en cada push a
`main` — no hay paso de compilación, es HTML/CSS/JS plano.

> Nota: GitHub Pages con repositorio **privado** requiere un plan GitHub
> Pro, Team o Enterprise; en una cuenta gratuita el repo tiene que ser
> público para poder publicar Pages. Y aunque el repo sea privado, la web
> publicada sigue siendo accesible por su URL para cualquiera que la
> tenga — GitHub Pages no restringe el acceso a la página en sí salvo en
> planes Enterprise.

### 3. Configurar la app

Abre la web publicada → icono de ajustes:

- **URL del Worker**: pega la URL de `wrangler` del paso 1.
- **Cuenta de Pocket Casts**: tu email y contraseña.

---

## Uso

1. Busca un programa (o un episodio) desde la portada.
2. Abre un programa para ver su lista completa de episodios — baja con
   scroll para cargar más, o usa el buscador propio de esa lista para
   encontrar uno concreto.
3. Pulsa el botón de descarga en el episodio que quieras: se descarga de
   iVoox y se sube a Pocket Casts automáticamente, con su portada.
4. El botón de información (ⓘ) abre la ficha completa de un episodio sin
   salir de la lista.

Los episodios marcados como **exclusivos** no tienen botón de descarga:
es contenido de pago de iVoox y esta herramienta no lo toca.

---

## Persistencia y seguridad

Todo lo que guarda PodBridge vive **solo en tu navegador** — no hay base
de datos ni backend propio. Qué se guarda, dónde y por qué:

| Dato | Dónde | Cifrado | Notas |
|---|---|---|---|
| URL del Worker | `localStorage` | — | No es sensible |
| Favoritos | `localStorage` | — | No es sensible |
| Episodios ya subidos | `localStorage` | — | No es sensible |
| Token de Pocket Casts (sesión activa) | `sessionStorage` | — | Se borra al cerrar la pestaña |
| Token de Pocket Casts ("recordarme") | `localStorage` | Sí (AES-GCM) | Solo si activas la casilla |
| Contraseña de Pocket Casts | *(no se guarda)* | — | Ni siquiera cifrada; viaja una vez y se descarta |

**"Recordarme en este dispositivo"** es opcional y desactivado por
defecto. Al activarlo, el token de sesión (no la contraseña) se cifra con
`AES-GCM` usando una clave que se genera con Web Crypto y se guarda en
`IndexedDB` marcada como **no exportable**: ni la propia app puede sacar
los bytes de la clave, solo pedirle al navegador que cifre o descifre con
ella. Eso protege el token si alguien copia los ficheros de
`localStorage`/`IndexedDB` fuera de este navegador — sin la clave, que
nunca sale de tu perfil de navegador, el texto cifrado no sirve de nada.

Lo que esto **no** protege es un script malicioso corriendo en la propia
página (XSS): con acceso de ejecución en el origen, podría pedir al
navegador que descifre igual que hace la app. Es defensa en profundidad
frente a acceso pasivo a los datos guardados, no una garantía absoluta —
por eso sigue siendo opcional, y por eso no se te pide activarlo. En un
ordenador compartido, mejor no activarlo — el mismo interruptor sirve para
olvidar la sesión recordada en cualquier momento, basta con desactivarlo.

---

## Cómo funciona el Worker por dentro

`worker/proxy-worker.js` expone estos endpoints:

| Endpoint | Qué hace |
|---|---|
| `GET /health` | Comprobación de vida, la usa la app para el indicador de estado |
| `GET /ivoox/search?q=&type=` | Busca programas o episodios en iVoox |
| `GET /ivoox/program?url=&page=` | Info de un programa + una página de sus episodios |
| `GET /ivoox/audio?url=&filename=` | Retransmite el mp3 real de un episodio (`filename` sugiere el nombre al descargarlo) |
| `GET /ivoox/image?url=` | Retransmite una portada (programa o episodio) |
| `GET /ivoox/raw?url=` | HTML crudo de una URL de iVoox, solo para depurar el scraper |
| `POST /pocketcasts/login` | Login contra Pocket Casts, devuelve el token de sesión |
| `GET /pocketcasts/usage` | Espacio usado/disponible en Archivos (bytes) |
| `POST /pocketcasts/upload-episode` | Descarga el audio de iVoox y lo sube a Archivos, del todo en el Worker |
| `POST /pocketcasts/upload-image` | Sube la portada de un episodio ya subido |

El tamaño de cada episodio que se ve en la lista sale de una petición
`HEAD` en paralelo por episodio (solo mira `Content-Length`, no descarga
nada) al listar los episodios de un programa — si alguna falla o el CDN no
manda ese encabezado, ese episodio simplemente se queda sin tamaño en vez
de romper el listado entero.

**iVoox no tiene API pública.** El Worker interpreta directamente el HTML
de sus páginas (dos plantillas distintas: la búsqueda usa microdatos
`itemprop`, la ficha de programa es una SPA Nuxt con enlaces relativos).
La exclusividad de un episodio se detecta por la clase real de su botón
de reproducción (`round-play btn-fans` frente a `btn-primary`), y el mp3
real se resuelve de forma determinista a partir del id del episodio
(`listen_mn_<id>_1.mp3`), sin necesidad de re-scrapear nada. La lista de
programas Originals se obtiene del catálogo dedicado de iVoox y se cachea
6 horas, porque no hay ninguna marca de "Originals" fiable ni en la ficha
de un programa ni en su tarjeta de búsqueda.

**Pocket Casts tampoco tiene API pública.** El Worker reproduce el flujo
que usan sus apps oficiales (reverse-engineered): `POST /user/login` para
el token, y `POST /files/upload/request` con un mensaje **protobuf**
(`uuid`, `title`, `size`, `contentType`, `hasCustomImage_p`) que devuelve
una URL de S3 pre-firmada donde subir el audio. Si el episodio tiene
portada, hay un segundo paso independiente — `POST /files/upload/image`
con el mismo `uuid` — que da otra URL pre-firmada para la imagen; si ese
segundo paso falla no bloquea nada, el episodio se queda sin portada
propia.

El audio en sí **no llega a pasar por el navegador**: `/pocketcasts/upload-episode`
recibe solo la URL del episodio y el título (una petición pequeña), y es
el propio Worker quien descarga el mp3 de iVoox y lo sube a Pocket Casts,
retransmitiendo en streaming directo de un sitio a otro sin bufferizar
nada en memoria. Esto se decidió a base de descartar dos alternativas más
obvias que se probaron antes y que fallan con episodios largos (~5h,
260-300 MB):

- **Navegador descarga y se lo reenvía al Worker para que lo suba.**
  Cloudflare Workers limita a 100 MB el cuerpo de las peticiones que
  RECIBE (plan gratuito/Pro) — se atascaba justo al llegar a esa fase.
- **Navegador sube directo a la URL pre-firmada de Pocket Casts, sin
  Worker de por medio** (que es justo lo que hace la app oficial: el
  dispositivo sube el fichero directo al almacenamiento). Bloqueado por
  CORS — ese almacenamiento no está pensado para que le hable un
  navegador, solo las apps nativas, que no tienen ese problema porque
  CORS es una restricción exclusiva de navegadores.

Haciendo la descarga+subida del todo dentro del Worker se evita el primer
límite (que solo aplica a lo que el Worker *recibe*, no a las peticiones
que él mismo hace hacia fuera) y el problema de CORS no existe entre
servidores. Quedaban tres detalles nada evidentes por resolver dentro de
esto, cada uno descubierto al chocar con el siguiente episodio de prueba
grande (~260-270 MB):

- Encadenar directamente el cuerpo de la respuesta de iVoox como cuerpo
  de la petición a Pocket Casts (`body: audioRes.body`) provoca un 413
  aleatorio en ficheros grandes.
- Intercalar un `TransformStream` normal en medio arregla el 413, pero el
  runtime de Workers manda entonces el cuerpo como
  `Transfer-Encoding: chunked` en cuanto es un stream de longitud
  desconocida — y las URLs pre-firmadas de S3 (que es lo que hay detrás
  de Pocket Casts) no soportan chunked, lo rechazan con un 501.
  `FixedLengthStream` (un `TransformStream` al que se le dice de
  antemano cuántos bytes va a dejar pasar) arregla esto: el runtime lo
  usa como `Content-Length` real en vez de recurrir a chunked.
- Con eso arreglado, conectar el readable de iVoox con el writable de
  `FixedLengthStream` mediante `.pipeTo()` (la forma "normal" de unir dos
  streams) seguía rompiendo con ficheros grandes — no con un error HTTP
  limpio, sino tirando la conexión entera a medias, algo que en el
  navegador se ve como un CORS/`Failed to fetch` espurio porque nunca
  llega a haber una respuesta real. La sospecha es que el runtime de
  Workers no propaga bien la contrapresión al encadenar streams con
  `pipeTo()`, así que se sustituyó por un bombeo manual (un bucle que
  espera a que cada escritura se resuelva antes de pedir el siguiente
  trozo) — mejora las cosas pero **no las arregla del todo**: ver
  "Episodios muy grandes" más abajo.

La contrapartida de todo este diseño es que el navegador ya no puede
pintar un progreso real en bytes durante esta fase (es una única
petición de principio a fin): la UI la muestra como indeterminada en vez
de fingir un porcentaje. La portada, que siempre es pequeña, sigue
subiendo desde el navegador con progreso real.

### Episodios muy grandes (varios cientos de MB)

**Estado actual: sin resolver del todo.** Con episodios de varias horas
(~250-280 MB), la subida automática de servidor a servidor sigue
fallando en la práctica incluso después de los tres ajustes de streaming
de arriba — el último diagnóstico en producción (con `wrangler tail`)
muestra el PUT hacia Pocket Casts cortándose con un "Network connection
lost" a los pocos cientos de KB, sin que quede claro todavía si es un
límite duro del runtime de Workers para peticiones salientes largas, algo
específico de la conexión con el almacenamiento de Pocket Casts, o algo
que aún se puede arreglar por streaming. Se sigue investigando.

Mientras tanto, la lista de episodios enseña un botón adicional de
**descargar mp3** (icono de flecha hacia abajo, junto al de información)
en cualquier episodio de más de ~100 MB: descarga el audio directo al
navegador vía `/ivoox/audio` — una respuesta en streaming normal, que
nunca ha tenido ninguno de estos problemas porque no es una petición
saliente del Worker — y desde ahí puedes subirlo tú mismo a Pocket Casts
usando su app oficial (Archivos → Subir un fichero), que al subir
directamente desde tu dispositivo no pasa por ninguno de los límites de
por medio. El botón normal de "Descargar y subir" se deja igualmente
disponible por si la subida automática termina de arreglarse.

Como ninguna de las dos es una API pública documentada, **pueden cambiar
sin aviso**. Si algo deja de funcionar (títulos raros, episodios que no
aparecen, login o subida rotos), el sitio donde mirar es siempre
`worker/proxy-worker.js`:

1. Para iVoox: abre `https://TU-WORKER.workers.dev/ivoox/raw?url=<la-url-que-falla>`
   para ver el HTML real que ve el Worker, y ajusta `parseProgramCards` /
   `parseEpisodeCards` / `resolveAudioUrl` según lo que haya cambiado.
2. Para Pocket Casts: la sección "Pocket Casts" del archivo, con el login
   y las dos subidas (audio e imagen).

---

## Limitaciones y cosas a tener en cuenta

- **Scraping best-effort.** No hay contrato estable con iVoox: un cambio
  en su web puede romper la búsqueda o la lista de episodios hasta que se
  actualice el Worker (ver sección anterior).
- **Solo contenido público.** Los episodios exclusivos (Premium/Fans) no
  se pueden descargar, a propósito.
- **Búsqueda de episodios aproximada.** No hay forma de indexar episodios
  sueltos por palabra clave contra iVoox; se buscan los programas más
  afines y se filtran sus episodios. Para un episodio muy concreto suele
  ir mejor abrir el programa y usar el buscador de esa lista.
- **Cada usuario necesita su propio Worker.** No es una limitación
  técnica sino de diseño: así ningún dato ni credencial pasa por un
  servidor compartido.
- **Límites del plan gratuito de Cloudflare Workers**: 100.000 peticiones
  al día y un tope de tiempo de CPU activo por petición (no de tiempo de
  espera de red, que es la mayor parte de lo que hace este Worker). De
  sobra para uso personal; si algún día se superan, Cloudflare empieza a
  devolver error hasta el día siguiente.
- **Riesgo de bloqueo o incumplimiento de términos de servicio.** Tanto
  raspar la web de iVoox como hablar la API privada de Pocket Casts
  probablemente incumple los términos de uso de ambos servicios, aunque
  el uso sea personal y legítimo. Un uso intensivo (muchas búsquedas o
  descargas seguidas) aumenta el riesgo de que iVoox limite o bloquee el
  tráfico.
- **La subida de Archivos a Pocket Casts requiere una suscripción Pocket
  Casts Plus.** Sin ella, Pocket Casts rechaza la solicitud.
- **Sin progreso en bytes durante la subida del audio.** Al hacerse
  entera dentro del Worker (ver arriba), esa fase se muestra como
  indeterminada en vez de un porcentaje — sí se cancela igual (a mano o
  sola a los 45s sin señal de vida) y tiene un límite de seguridad de 15
  minutos en el propio Worker.
- **Persistencia solo local, sin sincronizar.** Favoritos, historial de
  subidas y la sesión recordada viven en `localStorage`/`IndexedDB` de
  este navegador — no se sincronizan entre dispositivos ni navegadores;
  en cada uno hay que marcar los favoritos y activar "recordarme" por
  separado. Borrar los datos del sitio en el navegador los elimina.

---

## Estructura del repositorio

```
index.html                        Esqueleto de la SPA (una sola página)
css/styles.css                    Diseño (claro/oscuro automático, responsive)

js/main.js                        Cableado de la UI y orquestación de vistas
js/state.js                       Store (búsqueda, programa, sesión, favoritos, historial, jobs)
js/crypto-store.js                Cifrado AES-GCM del token recordado (clave no exportable en IndexedDB)
js/download.js                    Flujo descargar → subir por episodio
js/utils.js                       Formateo, helpers varios

js/api/ivoox.js                   Cliente contra los endpoints /ivoox/* del Worker
js/api/pocketcasts.js             Cliente contra los endpoints /pocketcasts/* del Worker
js/api/proxy.js                   fetch genérico + comprobación de salud del Worker

js/components/cards.js            Tarjetas de programa/episodio, botones de acción
js/components/episodeModal.js     Popup de "más información" de un episodio
js/components/overlay.js          Apertura/cierre de paneles y popups
js/components/states.js           Estados de carga, vacío y error
js/components/toast.js            Notificaciones flotantes

worker/proxy-worker.js            El puente: scraping de iVoox + protobuf de Pocket Casts
worker/wrangler.toml              Configuración de despliegue del Worker

.github/workflows/deploy.yml      Publicación automática en GitHub Pages
```

---

## Licencia

[MIT](LICENSE).

---

## Aviso de uso

PodBridge es una herramienta personal, no oficial y sin afiliación con
iVoox ni con Pocket Casts. Solo descarga audio de acceso público en
iVoox — los episodios exclusivos quedan bloqueados a propósito — y solo
sube contenido a la cuenta de Pocket Casts con la que te identifiques tú
mismo. Úsala solo con tu propia cuenta y con contenido al que ya tengas
acceso legítimo.
