# PodBridge — iVoox → Pocket Casts

Busca programas y episodios de iVoox y súbelos directamente a tus **Archivos**
de Pocket Casts, sin pasos manuales. Los episodios **exclusivos** de iVoox se
identifican y quedan bloqueados: esta herramienta solo descarga audio de
acceso público, nunca contenido de pago.

## Cómo está montado (y por qué)

GitHub Pages solo sirve ficheros estáticos. Pero para que la app funcione de
verdad hacen falta dos cosas que un navegador no puede hacer por sí solo:

1. **Buscar en iVoox.** iVoox no tiene una API JSON pública — su búsqueda
   son páginas HTML normales. Hay que descargarlas e interpretarlas
   (scraping), y además su servidor no manda cabeceras CORS para permitir
   que un origen externo (`tu-usuario.github.io`) las lea con `fetch`.
2. **Subir a Pocket Casts.** Su API (`api.pocketcasts.com`) no es pública,
   usa mensajes **protobuf** binarios para subir ficheros y tampoco habilita
   CORS para orígenes de terceros.

La solución es un **Worker de Cloudflare** (`/worker`, gratis, tuyo) que hace
de puente: el frontend estático en GitHub Pages le habla a tu Worker, y tu
Worker habla con iVoox y Pocket Casts. Tus credenciales de Pocket Casts pasan
por infraestructura que controlas tú — nunca por un servidor de un tercero.

```
Navegador (GitHub Pages) ──fetch──▶ Tu Worker (Cloudflare) ──▶ iVoox (scraping)
                                                          └──▶ Pocket Casts (protobuf)
```

## 1. Desplegar el Worker

```bash
cd worker
npx wrangler login        # una vez
npx wrangler deploy
```

Wrangler te dará una URL tipo `https://podbridge-proxy.tu-cuenta.workers.dev`.
Guárdala, la necesitas en el paso 3.

Opcional pero recomendado: una vez tengas la URL de tu GitHub Pages, edita
`worker/wrangler.toml` y cambia `ALLOWED_ORIGIN = "*"` por tu dominio real
(`https://tu-usuario.github.io`), y vuelve a desplegar.

## 2. Publicar el frontend en GitHub Pages

Sube este repositorio a GitHub y activa Pages:
**Settings → Pages → Build and deployment → GitHub Actions**. El workflow en
`.github/workflows/deploy.yml` publica la raíz del repo en cada push a
`main` (no hay build step: es HTML/CSS/JS plano).

## 3. Configurar la app

Abre la web publicada → icono de ajustes (⚙️):

- **URL del Worker**: pega la URL de wrangler del paso 1.
- **Cuenta de Pocket Casts**: tu email y contraseña. Se envían a tu propio
  Worker y de ahí a Pocket Casts; solo se guardan en `sessionStorage` de esa
  pestaña (se borran al cerrarla). El token de sesión resultante es lo único
  que queda en memoria del navegador.

## Sobre el scraping de iVoox (léelo antes de reportar un "no funciona")

iVoox no ofrece garantías de estabilidad para su HTML público, y de hecho
mezcla dos generaciones de plantillas distintas:

- Las páginas de **búsqueda de programas** (`podcast-{término}_sw_1_1_1.html`)
  son HTML "clásico" con microdatos `itemprop="name"/"url"/"description"`
  por tarjeta (`parseProgramCards`).
- Las páginas de **programa/episodios** son una SPA Nuxt donde casi todos
  los enlaces son **relativos** (`/episodio.html`, no
  `https://www.ivoox.com/episodio.html`) y el título de cada episodio va en
  un `<a class="...text-truncate...">` dentro de un `<h3>` (`parseEpisodeCards`).

La **exclusividad** se detecta por la clase del botón de reproducción:
`round-play btn-fans` en episodios del programa de Fans/pago de iVoox,
`round-play btn-primary` en los libres — más fiable que buscar la palabra
"exclusivo" en el texto. El **mp3 real** de un episodio libre se resuelve
sin necesidad de más scraping: iVoox lo sirve siempre en
`https://www.ivoox.com/listen_mn_<id-del-episodio>_1.mp3` (mismo `<id>` que
aparece como `_rf_<id>` en la URL del episodio), con un par de redirecciones
302 hasta su CDN (Triton Digital) — `resolveAudioUrl` solo construye esa URL,
no hace falta descargar la página del episodio para averiguarla.

Si algo de esto deja de funcionar (títulos raros, "No disponible" en masa,
programas sin episodios):

1. Abre `https://TU-WORKER.workers.dev/ivoox/raw?url=<la-url-que-falla>`
   en el navegador para ver el HTML real que ve el Worker.
2. Busca ahí las clases/atributos que usan las funciones de arriba
   (`itemprop`, `text-truncate`, `round-play`, `_rf_`) y comprueba si iVoox
   los ha cambiado.
3. Ajusta `parseProgramCards` / `parseEpisodeCards` / `resolveAudioUrl` en
   `worker/proxy-worker.js` en consecuencia y vuelve a `wrangler deploy`.

**Búsqueda de episodios:** iVoox no indexa episodios sueltos por palabra
clave (solo programas). Cuando buscas en modo "Episodios", el Worker busca
primero los programas más afines a tu término y luego filtra los episodios
de esos programas cuyo título la contiene — es una aproximación razonable,
no una búsqueda global real. Para encontrar un episodio muy concreto suele
ir mejor buscar el programa y abrir su lista completa.

## Sobre la API de Pocket Casts

`api.pocketcasts.com` es una API privada, no documentada oficialmente. Este
proyecto implementa el flujo de subida de Archivos tal y como lo hacen las
apps oficiales (reverse-engineered): `POST /user/login` para el token, y
`POST /files/upload/request` con un mensaje protobuf (`uuid`, `title`,
`size`, `contentType`) que devuelve una URL S3 pre-firmada donde se sube el
audio con `PUT`. La subida de Archivos a la nube **requiere Pocket Casts
Plus**; sin esa suscripción, Pocket Casts rechazará la solicitud.

Como es una API privada, puede cambiar sin aviso. Si el login o la subida
empiezan a fallar, `worker/proxy-worker.js` (sección "Pocket Casts") es el
único sitio que hay que tocar.

## Estructura del repo

```
index.html              Esqueleto de la SPA (una sola página)
css/styles.css           Diseño (claro/oscuro automático, responsive)
js/main.js                Cableado de la UI y orquestación de vistas
js/state.js                Store mínimo (búsqueda, programa, sesión, jobs)
js/download.js              Flujo descargar → subir por episodio
js/api/ivoox.js              Cliente contra los endpoints /ivoox/* del Worker
js/api/pocketcasts.js         Cliente contra los endpoints /pocketcasts/* del Worker
js/api/proxy.js                 fetch genérico hacia el Worker
js/components/                   Tarjetas, estados (idle/empty/error), toasts
worker/proxy-worker.js  El puente: scraping de iVoox + protobuf de Pocket Casts
worker/wrangler.toml     Configuración de despliegue del Worker
```

## Límites conocidos

- Sin backend con más recursos, los ficheros de audio pasan en streaming a
  través de tu Worker (dentro de los límites gratuitos de Cloudflare, de
  sobra para episodios de podcast normales).
- El scraping de iVoox es best-effort por definición: no hay contrato
  estable que garantice que siga funcionando indefinidamente sin ajustes.
- Solo se pueden descargar episodios de acceso público. Los exclusivos
  (Premium) están bloqueados a propósito.

## Aviso

Herramienta personal no oficial, sin afiliación con iVoox ni con Pocket
Casts. Úsala solo con tu propia cuenta y con contenido al que ya tengas
acceso legítimo.
