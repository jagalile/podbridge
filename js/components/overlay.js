// Apertura/cierre genérico para los overlays de la app (panel de ajustes,
// popup de episodio), todos compartiendo un único fondo (#backdrop).
//
// Se controlan por clase (.is-open), no por el atributo `hidden`: algunos
// overlays fijan `display` incondicionalmente en su CSS, y una regla de
// autor con `display` siempre gana sobre `[hidden]` (que es una regla de
// la hoja de estilos del user-agent) — así que mezclar ambos mecanismos
// deja al `hidden` sin efecto visual. Con clases no hay ambigüedad posible.

const backdrop = document.getElementById("backdrop");
let active = null;
let onCloseCallback = null;

export function openOverlay(el, { onClose } = {}) {
  if (active && active !== el) closeOverlay();
  active = el;
  onCloseCallback = onClose || null;
  el.classList.add("is-open");
  backdrop.classList.add("is-open");
}

export function closeOverlay() {
  if (!active) return;
  active.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  const cb = onCloseCallback;
  active = null;
  onCloseCallback = null;
  cb?.();
}

backdrop.addEventListener("click", closeOverlay);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOverlay();
});
