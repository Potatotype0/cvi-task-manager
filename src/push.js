import { supabase } from './lib.js'

const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY

// Android offers an install prompt once. It is kept here so a button can show it later.
let installPrompt = null
const installListeners = new Set()
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installPrompt = e
  installListeners.forEach((listener) => listener())
})
export const canPromptInstall = () => Boolean(installPrompt)
export const onInstallAvailable = (listener) => {
  installListeners.add(listener)
  return () => installListeners.delete(listener)
}
export async function promptInstall() {
  if (!installPrompt) return
  installPrompt.prompt()
  await installPrompt.userChoice
  installPrompt = null
}

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isPhone = () => isIOS() || /Android/i.test(navigator.userAgent)
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true

export function registerWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {})
}

function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '='))
  return Uint8Array.from(text, (c) => c.charCodeAt(0))
}

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

// off | on | blocked | unsupported | needs-install (iPhones only allow this from the Home Screen)
export async function pushState() {
  if (isIOS() && !isInstalled()) return 'needs-install'
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  if (Notification.permission !== 'granted') return 'off'
  return (await currentSubscription()) ? 'on' : 'off'
}

async function saveSubscription(subscription, language) {
  const { endpoint, keys } = subscription.toJSON()
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth, p_language: language,
  })
  if (error) throw error
}

// Must be called from a click: iPhones refuse the permission question otherwise.
export async function enablePush(language) {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
    || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) })
  await saveSubscription(subscription, language)
  return true
}

export async function disablePush() {
  if (!supported() || !navigator.serviceWorker.controller) return
  const subscription = await currentSubscription()
  if (!subscription) return
  await supabase.rpc('delete_push_subscription', { p_endpoint: subscription.endpoint })
  await subscription.unsubscribe()
}

// Keeps the device linked to whoever is logged in, in their current language.
export async function refreshPush(language) {
  if (!supported() || Notification.permission !== 'granted') return
  const subscription = await currentSubscription()
  if (subscription) await saveSubscription(subscription, language)
}
