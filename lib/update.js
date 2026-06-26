export function onUpdateAvailable(registration, callback, navigatorObj = navigator) {
  if (!registration) return;
  registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing;
    if (!newWorker) return;
    newWorker.addEventListener('statechange', () => {
      if (newWorker.state === 'installed' && navigatorObj.serviceWorker.controller) {
        callback();
      }
    });
  });
}

export function applyUpdate(registration) {
  if (registration && registration.waiting) {
    registration.waiting.postMessage('skipWaiting');
  }
}
