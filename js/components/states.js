// Bloques reutilizables de estado: idle / loading (skeletons) / empty / error.

import { clone } from "../utils.js";

export function skeletonGrid(container, count = 8) {
  container.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "grid";
  for (let i = 0; i < count; i++) grid.appendChild(clone("tpl-skeleton-card"));
  container.appendChild(grid);
}

export function stateBlock(container, { icon, title, text, tone, actionLabel, onAction }) {
  container.innerHTML = "";
  const block = document.createElement("div");
  block.className = "state-block";
  if (tone) block.dataset.tone = tone;
  block.innerHTML = `
    <div class="state-icon">${icon}</div>
    <h2>${title}</h2>
    <p>${text}</p>
  `;
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.type = "button";
    btn.textContent = actionLabel;
    btn.addEventListener("click", onAction);
    block.appendChild(btn);
  }
  container.appendChild(block);
}

export function idleState(container) {
  stateBlock(container, {
    icon: "🎧",
    title: "Empieza buscando un programa o un episodio",
    text: "Los resultados de iVoox aparecerán aquí, junto con su tipo (Originals / independiente) y disponibilidad de descarga.",
  });
}

export function emptyState(container, query) {
  stateBlock(container, {
    icon: "🔍",
    title: "Sin resultados",
    text: `No hemos encontrado nada para “${query}”. Prueba con otro término o cambia entre Programas y Episodios.`,
  });
}

export function errorState(container, message, onRetry) {
  stateBlock(container, {
    icon: "⚠️",
    title: "Algo ha ido mal",
    text: message,
    tone: "error",
    actionLabel: onRetry ? "Reintentar" : undefined,
    onAction: onRetry,
  });
}

export function proxyMissingState(container, onOpenSettings) {
  stateBlock(container, {
    icon: "🔌",
    title: "Falta conectar el puente",
    text: "Para buscar en iVoox necesitas configurar la URL de tu Worker en Ajustes.",
    actionLabel: "Abrir ajustes",
    onAction: onOpenSettings,
  });
}
