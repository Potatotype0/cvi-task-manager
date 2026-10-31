import React, { useCallback, useEffect, useState } from 'react'
import { useApp } from './lib.js'
import { Modal } from './tasks.jsx'
import { Icon } from './icons.jsx'
import { canPromptInstall, enablePush, isIOS, isInstalled, isPhone, onInstallAvailable, promptInstall, pushState } from './push.js'

const remembered = (key) => { try { return localStorage.getItem(key) === '1' } catch { return false } }
const remember = (key) => { try { localStorage.setItem(key, '1') } catch {} }

export function InstallGuide({ onClose }) {
  const { t } = useApp()
  const [phone, setPhone] = useState(isIOS() ? 'iphone' : 'android')
  const [canInstall, setCanInstall] = useState(canPromptInstall())
  useEffect(() => onInstallAvailable(() => setCanInstall(true)), [])

  async function install() {
    await promptInstall()
    setCanInstall(false)
    onClose()
  }

  const steps = phone === 'iphone'
    ? [t('iosStep1'), t('iosStep2'), t('iosStep3'), t('iosStep4')]
    : [t('androidStep1'), t('androidStep2'), t('androidStep3')]

  return (
    <Modal title={t('installTitle')} onClose={onClose}>
      <div className="stack">
        <p>{t('installWhy')}</p>
        <div className="segmented">
          <button type="button" className={phone === 'iphone' ? 'on' : ''} onClick={() => setPhone('iphone')}>iPhone</button>
          <button type="button" className={phone === 'android' ? 'on' : ''} onClick={() => setPhone('android')}>Android</button>
        </div>
        {phone === 'android' && canInstall
          ? <button className="btn primary big" onClick={install}>{t('installNow')}</button>
          : <ol className="steps">{steps.map((step) => <li key={step}>{step}</li>)}</ol>}
        {phone === 'iphone' && <p className="muted">{t('iosVersion')}</p>}
      </div>
    </Modal>
  )
}

// Asks once per device, and only offers what this device can actually do.
export function NotificationPrompt({ onInstall, version }) {
  const { t, lang, toast } = useApp()
  const [state, setState] = useState(null)
  const [hidden, setHidden] = useState(() => remembered('cvi-notify-dismissed'))

  useEffect(() => { pushState().then(setState).catch(() => setState('unsupported')) }, [version])

  const turnOn = useCallback(async () => {
    try {
      const on = await enablePush(lang)
      toast(on ? t('notifyOn') : t('notifyBlocked'), !on)
      setState(await pushState())
    } catch (err) {
      toast(err.message, true)
    }
  }, [lang, t, toast])

  if (hidden || !['off', 'needs-install'].includes(state)) return null
  return (
    <div className="notify-bar">
      <Icon name="bell" />
      <span>{state === 'off' ? t('notifyAsk') : t('notifyInstallFirst')}</span>
      {state === 'off'
        ? <button className="btn small primary" onClick={turnOn}>{t('notifyTurnOn')}</button>
        : <button className="btn small primary" onClick={onInstall}>{t('installTitle')}</button>}
      <button className="icon-btn small" onClick={() => { remember('cvi-notify-dismissed'); setHidden(true) }} aria-label={t('cancel')}><Icon name="close" size={15} /></button>
    </div>
  )
}

export function shouldOfferInstall() {
  if (!isPhone() || isInstalled() || remembered('cvi-install-seen')) return false
  remember('cvi-install-seen')
  return true
}
