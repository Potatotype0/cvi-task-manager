// Handles phone notifications only. Pages are not cached, so people always get the latest version.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  event.waitUntil(self.registration.showNotification(data.title || 'CVI Task Manager', {
    body: data.body || '',
    icon: new URL('icons/icon-192.png', self.registration.scope).href,
    badge: new URL('icons/icon-192.png', self.registration.scope).href,
    data: { taskId: data.taskId || null },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { taskId } = event.notification.data || {}
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.length) {
      await windows[0].focus()
      if (taskId) windows[0].postMessage({ openTask: taskId })
      return
    }
    await self.clients.openWindow(new URL(taskId ? `?task=${taskId}` : '.', self.registration.scope).href)
  })())
})
