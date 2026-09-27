self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {

  if (!event.data) return;

  if (event.data.type === "NOTIFY") {

    const title =
      event.data.title || "KPSS Odak Merkezi";

    const options = {
      body:
        event.data.body || "Çalışma tamamlandı 🎯",
      tag: "kpss-timer",
      renotify: true
    };

    event.waitUntil(
      self.registration.showNotification(
        title,
        options
      )
    );
  }

});
