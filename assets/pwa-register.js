(() => {
  if (
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    window.location.protocol === "file:"
  ) {
    return;
  }

  void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(
    (error) => {
      // PWA support is optional. A blocked worker must never prevent login or
      // the Codex browser bridge from starting.
      console.warn("[pwa] service worker registration failed", error);
    },
  );
})();
