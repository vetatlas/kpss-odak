self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    self.clients.claim()
  );
});

self.addEventListener("message", event => {

  if (!event.data) return;

  if (event.data.type === "NOTIFY") {

    const title =
      event.data.title ||
      "KPSS Odak Merkezi 🎯";

    const options = {

      body:
        event.data.body ||
        "Çalışma devam ediyor.",

      tag: "kpss-timer",

      renotify: true,

      icon: "./icon-192.png",

      badge: "./icon-192.png",

      requireInteraction: false,

      vibrate: [200, 100, 200]

    };

    event.waitUntil(

      self.registration.showNotification(
        title,
        options
      )

    );

  }

});
