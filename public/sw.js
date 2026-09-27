/*
 * Service Worker da Lima's Locacoes.
 *
 * DUAS funcoes, com fronteiras claras:
 *
 * 1) PUSH (como sempre foi): exibicao e clique nas notificacoes, com
 *    deduplicacao por IndexedDB. Nada mudou aqui.
 *
 * 2) CACHE DE ASSETS ESTATICOS (auditoria de performance): na PWA instalada,
 *    cada abertura fria re-baixava icones, manifest e os chunks JS/CSS do
 *    app. No iPhone o HTTP cache do Safari e agressivo em PODAR disco, e a
 *    PWA nao tem barra para o usuario perceber a espera — entao cacheamos
 *    no lado do SW o que nunca muda:
 *      - /_next/static/...  -> conteudo com hash no nome do arquivo (imutavel)
 *      - /icones/...        -> logo e icones do app
 *      - /manifest.webmanifest
 *    Estrategia cache-first com preenchimento sob demanda (stale-while-revalidate
 *    dos assets): a primeira visita baixa da rede e guarda; as seguintes vem do
 *    cache na hora; a versao nova chega sozinha porque o nome do arquivo muda
 *    com o hash — nunca existe versao antiga presa em cache para HTML/API.
 *
 *    O QUE NUNCA E CACHEADO: HTML de navegacao, /api/*, /portal/*, uploads e
 *    qualquer pagina autenticada. O sistema continua exigindo rede para dados,
 *    como sempre — zero risco de dado velho ou vazamento em cache compartilhado.
 *
 * Atualizacao do proprio SW: o registro usa updateViaCache:"none" (PushRegistration)
 * e install chama skipWaiting + activate chama clients.claim, entao o worker novo
 * assume sem deixar o usuario preso em versao antiga. Caches de versoes anteriores
 * sao apagados no activate (limpeza por whitelist).
 */
const CACHE = "limas-static-v1";
const PREFIXOS_CACHEAVEIS = ["/_next/static/", "/icones/", "/manifest.webmanifest"];

/** URL cacheavel? Somente GET, mesma origem e caminho da lista acima. */
function cacheavel(url) {
  if (url.origin !== self.location.origin) return false;
  return PREFIXOS_CACHEAVEIS.some((p) => (p.endsWith("/") ? url.pathname.startsWith(p) : url.pathname === p));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Pre-cache minimo: icones e manifest. Pequenos, estaveis e usados na
      // primeira tela da PWA. Chunks JS/CSS entram sob demanda no primeiro uso.
      await Promise.allSettled([
        cache.addAll(["/icones/icone-192.png", "/icones/icone-512.png", "/manifest.webmanifest"]),
      ]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Apaga caches que nao sao da versao atual (troca de versao do worker).
      const nomes = await caches.keys();
      await Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!cacheavel(url)) return; // HTML, API, uploads, portal: sempre rede

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // So guarda resposta de sucesso vinda da propria origem.
        if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
        return res;
      } catch (e) {
        // Offline e sem cache: deixa o erro seguir (comportamento de sempre).
        throw e;
      }
    })(),
  );
});

/* ------------------------------ push (inalterado) ------------------------------ */

function claimNotification(id) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("limas-push", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("seen", { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("seen", "readwrite");
      const store = tx.objectStore("seen");
      let fresh = false;
      const lookup = store.get(id);
      lookup.onsuccess = () => {
        if (!lookup.result) { fresh = true; store.put({ id, at: Date.now() }); }
        const cursor = store.openCursor();
        cursor.onsuccess = () => { const c = cursor.result; if (c) { if (c.value.at < Date.now()-7*86400000) c.delete(); c.continue(); } };
      };
      tx.oncomplete = () => { db.close(); resolve(fresh); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    if (!data || !data.id) return;
    let fresh = true;
    try { fresh = await claimNotification(String(data.id)); } catch { /* Notification tag remains a second dedupe layer. */ }
    if (!fresh) return;
    const url = new URL(data.url || "/notificacoes", self.location.origin);
    await self.registration.showNotification(data.title || "Lima's Locacoes", {
      body: data.body || "Confira suas atividades.", icon:"/icones/icone-192.png", badge:"/icones/icone-192.png",
      tag:`limas-${data.id}`, renotify:false, vibrate:[150,80,150],
      data:{url:url.origin===self.location.origin?url.href:new URL("/notificacoes",self.location.origin).href},
    });
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge().catch(() => {});
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || "/notificacoes", self.location.origin);
    if (url.origin !== self.location.origin) return;
    const windows = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const client = windows.find(c => new URL(c.url).origin === url.origin);
    if (client) { await client.navigate(url.href); await client.focus(); }
    else await self.clients.openWindow(url.href);
  })());
});
