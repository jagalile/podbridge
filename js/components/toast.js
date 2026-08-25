import { escapeHtml } from "../utils.js";

const container = () => document.getElementById("toasts");

export function toast(message, tone = "info", timeout = 4200) {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;
  node.innerHTML = escapeHtml(message);
  container().appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity .2s ease";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 200);
  }, timeout);
}
