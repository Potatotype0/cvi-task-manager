import React, { useMemo, useState } from 'react'
import { emailOf, fill, signupClient, supabase, today, useApp, whatsappLink, whatsappNumber } from './lib.js'
import { Drawer } from './tasks.jsx'
import { saveWorkbook } from './reports.jsx'
import { Icon } from './icons.jsx'

// No 0/O or 1/l, because people often read these from a phone and type them by hand.
export function tempPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz'
  const digits = '23456789'
  const pick = (set, count) => Array.from(crypto.getRandomValues(new Uint32Array(count)), (n) => set[n % set.length]).join('')
  return `${pick(letters, 4)}-${pick(digits, 4)}`
}

// Creates one account. Used for single people and for the pasted list.
export async function createAccount({ username, full_name, password, phone, role, department_id }) {
  const invite = await supabase.from('invites').upsert({ username, full_name, role, department_id: department_id || null })
  if (invite.error) throw invite.error
  const { error } = await signupClient.auth.signUp({ email: emailOf(username), password })
  if (error) {
    await supabase.from('invites').delete().eq('username', username)
    throw error
  }
  if (phone) {
    const saved = await supabase.from('profiles').update({ phone }).eq('username', username)
    if (saved.error) throw saved.error
  }
  const recorded = await supabase.rpc('admin_record_password', { p_username: username, p_password: password })
  if (recorded.error) throw recorded.error
}

const roleWords = { employee: 'employee', manager: 'manager', 'موظف': 'employee', 'مدير': 'manager' }

// Excel pastes columns separated by tabs. Typed lists can use commas instead.
function parseStaff(text, departments, people, t) {
  const taken = new Set(people.map((p) => p.username))
  const seen = new Set()
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines[0] && /username|اسم المستخدم/i.test(lines[0])) lines.shift()

  return lines.map((line, index) => {
    const cells = (line.includes('\t') ? line.split('\t') : line.split(/[,،]/)).map((c) => c.trim())
    const [full_name = '', rawUsername = '', deptText = '', phone = '', roleText = ''] = cells
    const username = rawUsername.toLowerCase()
    const dept = departments.find((d) => [d.name_ar, d.name_en].some((n) => n.toLowerCase() === deptText.toLowerCase()))
    const errors = []
    if (!full_name) errors.push(t('importNoName'))
    if (!/^[a-z0-9._-]+$/.test(username)) errors.push(t('usernameRule'))
    else if (taken.has(username)) errors.push(t('importTaken'))
    else if (seen.has(username)) errors.push(t('importDuplicate'))
    if (deptText && !dept) errors.push(fill(t('importNoDept'), { name: deptText }))
    if (phone && !whatsappNumber(phone)) errors.push(t('phoneInvalid'))
    if (roleText && !roleWords[roleText.toLowerCase()]) errors.push(fill(t('importNoRole'), { name: roleText }))
    seen.add(username)
    return {
      key: index, full_name, username, phone, deptLabel: deptText, department_id: dept?.id || null,
      role: roleWords[roleText.toLowerCase()] || 'employee', errors,
    }
  })
}

export function ImportStaff({ onClose, onDone }) {
  const { t, lang, departments, people, toast } = useApp()
  const [text, setText] = useState('')
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => parseStaff(text, departments, people, t), [text, departments, people, t])
  const invalid = rows.filter((r) => r.errors.length).length

  const loginMessage = (r) => fill(t('loginMessage'), {
    name: r.full_name.split(' ')[0], link: `${location.origin}${location.pathname}`, username: r.username, password: r.password,
  })

  async function run(list) {
    setBusy(true)
    const out = results ? [...results] : list.map((r) => ({ ...r, password: tempPassword(), state: 'waiting' }))
    const todo = results ? out.filter((r) => r.state !== 'done') : out
    let limited = false
    for (const row of todo) {
      if (limited) { row.state = 'failed'; row.message = t('importLimit'); continue }
      try {
        await createAccount(row)
        row.state = 'done'
        row.message = ''
      } catch (err) {
        row.state = 'failed'
        limited = /rate|too many/i.test(err.message) || err.status === 429
        row.message = limited ? t('importLimit') : err.message
      }
      setResults([...out])
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    setResults([...out])
    setBusy(false)
    onDone()
  }

  const created = (results || []).filter((r) => r.state === 'done')
  const failed = (results || []).filter((r) => r.state === 'failed')

  function downloadList() {
    saveWorkbook([{
      name: t('people'),
      rows: created,
      columns: [[t('fullName'), (r) => r.full_name], [t('username'), (r) => r.username], [t('tempPassword'), (r) => r.password], [t('phone'), (r) => r.phone || '']],
    }], `CVI-staff-logins-${today()}.xlsx`, lang).catch((err) => toast(err.message, true))
  }

  function close() {
    onClose()
  }

  if (results) {
    return (
      <Drawer
        title={t('importStaff')}
        onClose={close}
        footer={<>
          {failed.length > 0 && <button className="btn" disabled={busy} onClick={() => run()}>{t('tryAgain')}</button>}
          <button className="btn" disabled={busy || !created.length} onClick={downloadList}><Icon name="download" />{t('downloadLogins')}</button>
          <button className="btn primary big" disabled={busy} onClick={close}>{t('done_btn')}</button>
        </>}
      >
        <p className="lead-small">{busy ? t('importWorking') : fill(t('importResult'), { done: created.length, failed: failed.length })}</p>
        {!busy && created.length > 0 && <p className="db-banner flush">{t('importSaveNow')}</p>}
        <div className="sheet">
          {results.map((r) => (
            <div className="item-row" key={r.key}>
              <div className="item-main">
                <strong>{r.full_name}</strong>
                {r.state === 'done' && <small className="login-line" dir="ltr">{r.username} / {r.password}</small>}
                {r.state === 'failed' && <small className="late">{r.message}</small>}
                {r.state === 'waiting' && <small className="muted">{t('importWaiting')}</small>}
              </div>
              {r.state === 'done' && whatsappLink(r.phone, 'x') && (
                <a className="btn small" href={whatsappLink(r.phone, loginMessage(r))} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={15} />{t('sendWhatsapp')}</a>
              )}
            </div>
          ))}
        </div>
      </Drawer>
    )
  }

  const ready = rows.length > 0 && invalid === 0
  return (
    <Drawer
      title={t('importStaff')}
      onClose={onClose}
      footer={<>
        {invalid > 0 && <p className="foot-note">{fill(t('importFix'), { n: invalid })}</p>}
        <button className="btn ghost" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary big" disabled={!ready || busy} onClick={() => run(rows)}>{fill(t('importCreate'), { n: rows.length })}</button>
      </>}
    >
      <p>{t('importHelp')}</p>
      <ol className="steps">
        <li><b>{t('fullName')}</b></li>
        <li><b>{t('username')}</b> <small className="muted">({t('usernameRule')})</small></li>
        <li><b>{t('department')}</b> <small className="muted">({t('optional')})</small></li>
        <li><b>{t('phone')}</b> <small className="muted">({t('optional')})</small></li>
        <li><b>{t('role')}</b> <small className="muted">({t('importRoleHint')})</small></li>
      </ol>
      <textarea
        rows="8"
        className="paste-box"
        aria-label={t('importStaff')}
        placeholder={t('importPlaceholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {rows.length > 0 && (
        <div className="sheet">
          {rows.map((r) => (
            <div className="item-row" key={r.key}>
              <div className="item-main">
                <strong>{r.full_name || '—'}</strong>
                <small className="muted"><span dir="ltr">{r.username}</span>{r.deptLabel && `، ${r.deptLabel}`}، {t(r.role)}{r.phone && <>، <span dir="ltr">{r.phone}</span></>}</small>
                {r.errors.map((e) => <small className="late" key={e}>{e}</small>)}
              </div>
              {r.errors.length === 0 && <Icon name="check" />}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  )
}
