const container = () => document.getElementById("toasts");

/**
 * @param {string} message
 * @param {"info"|"success"|"error"} tone
 * @param {{timeout?:number, actionLabel?:string, onAction?:()=>void}} opts
 *   `actionLabel`/`onAction` añaden un botón dentro del propio toast
 *   (p. ej. "Deshacer" al quitar un favorito) — pulsarlo lo cierra
 *   también, no hace falta esperar a que desaparezca solo.
 */
export function toast(message, tone = "info", { timeout = 4200, actionLabel, onAction } = {}) {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;

  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  node.appendChild(text);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    node.style.transition = "opacity .2s ease";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 200);
  };

  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      onAction();
      dismiss();
    });
    node.appendChild(btn);
  }

  container().appendChild(node);
  setTimeout(dismiss, timeout);
}
