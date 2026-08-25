// Cifrado del token de sesión de Pocket Casts para poder recordarlo entre
// visitas sin guardarlo en claro en localStorage.
//
// La clave AES-GCM se genera con Web Crypto, marcada `extractable: false`,
// y se guarda como objeto CryptoKey directamente en IndexedDB (el
// algoritmo de structured clone lo soporta sin serializar nada a mano).
// Al ser no exportable, ni el propio código de la app puede sacar los
// bytes de la clave — solo puede pedirle al navegador que cifre/descifre
// con ella. Esto protege el token si alguien copia los ficheros de
// localStorage/IndexedDB fuera de este navegador (otro perfil, otro
// dispositivo, una herramienta de sincronización...): sin la clave, que
// nunca sale de este navegador, el texto cifrado no sirve de nada.
//
// Lo que esto NO protege es un script malicioso corriendo en esta misma
// página (XSS): ese código podría pedir al navegador que descifre igual
// que hace la app. Es defensa en profundidad, no una bóveda infalible —
// ver el aviso en el propio panel de ajustes.

const DB_NAME = "podbridge-keys";
const STORE_NAME = "keys";
const KEY_ID = "pocketcasts-token-key";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getOrCreateKey() {
  const db = await openDb();
  const existing = await idbGet(db, KEY_ID);
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idbPut(db, KEY_ID, key);
  return key;
}

export async function encryptText(text) {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(cipher)) };
}

export async function decryptText({ iv, data }) {
  const key = await getOrCreateKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(data),
  );
  return new TextDecoder().decode(plain);
}

/** true si el navegador soporta lo necesario (IndexedDB + Web Crypto). */
export function cryptoStoreSupported() {
  return typeof indexedDB !== "undefined" && !!(crypto?.subtle);
}
