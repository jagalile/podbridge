// Mantiene la pantalla encendida mientras haya alguna descarga/subida en
// curso (Screen Wake Lock API) — pensado sobre todo para móvil: sin esto,
// el sistema apaga la pantalla por inactividad a mitad de una subida
// larga, y aunque eso ya no debería tirar el job a error (ver
// download.js), sigue siendo mejor que no llegue a pasar. No evita que
// el usuario apague la pantalla a propósito (pulsando el botón), solo el
// apagado automático por inactividad.
//
// La API no está en todos los navegadores (ni falta hace: sin ella, todo
// sigue funcionando igual, solo que la pantalla se puede apagar sola).

let sentinel = null;
let activeCount = 0;

async function acquire() {
  if (!("wakeLock" in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => { sentinel = null; });
  } catch {
    // Puede rechazar por varios motivos (batería baja, permiso denegado,
    // pestaña no visible en ese instante...) — no es crítico, simplemente
    // no se mantiene la pantalla encendida esta vez.
  }
}

function release() {
  if (!sentinel) return;
  sentinel.release().catch(() => {});
  sentinel = null;
}

/** Llamar cuando arranca un job (descarga o subida). */
export function noteJobStarted() {
  activeCount++;
  if (activeCount === 1) acquire();
}

/** Llamar cuando termina un job, sea con éxito, error o cancelación. */
export function noteJobEnded() {
  activeCount = Math.max(0, activeCount - 1);
  if (activeCount === 0) release();
}

// Mientras el wake lock está activo, el propio sistema no debería
// apagar la pantalla sola por inactividad — pero el navegador SÍ lo
// libera en cuanto la pestaña deja de estar visible por otro motivo
// (cambiar de app, minimizar el navegador...), y no lo recupera solo al
// volver. Si en ese momento sigue habiendo jobs en marcha, hay que
// volver a pedirlo a mano.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && activeCount > 0 && !sentinel) {
      acquire();
    }
  });
}
