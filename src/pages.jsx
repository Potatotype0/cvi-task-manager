import React, { useCallback, useEffect, useState } from 'react'
import { FREE_STORAGE_BYTES, TASK_SELECT, fill, isLate, supabase, today, uploadFile, useApp, whatsappNumber } from './lib.js'
import { ImportStaff, createAccount, tempPassword } from './import.jsx'
import { AssigneePicker, Avatar, ChecklistEditor, Drawer, Modal, PrioritySelect, TaskRow } from './tasks.jsx'
import { Icon } from './icons.jsx'

function useStorageUsed() {
  const { me } = useApp()
  const [used, setUsed] = useState(null)
  useEffect(() => {
    if (me.role === 'admin') supabase.rpc('storage_used_bytes').then(({ data, error }) => { if (!error) setUsed(Number(data)) })
  }, [me.role])
  return used
}

const toMb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`

function StorageMeter({ used }) {
  const { t } = useApp()
  if (used === null) return null
  const share = used / FREE_STORAGE_BYTES
  return (
    <section className="group">
      <h3>{t('storage')}</h3>
      <div className="sheet pad-sheet">
        <div className="load-text"><span>{fill(t('storageUsed'), { used: toMb(used), total: '1 GB' })}</span><b dir="ltr">{Math.round(share * 100)}%</b></div>
        <div className="bar"><i style={{ width: `${Math.min(share, 1) * 100}%` }} /></div>
        {share >= 0.8 && <p className="db-banner">{t('storageWarn')}</p>}
      </div>
    </section>
  )
}

export function Trash() {
  const { t, lang, me, toast, loadTasks, deptName } = useApp()
  const [rows, setRows] = useState([])
  const load = useCallback(async () => {
    const { data } = await supabase.from('tasks').select(TASK_SELECT).not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
    setRows((data || []).filter((x) => me.role === 'admin' || x.department_id === me.department_id || x.created_by === me.id))
  }, [me])
  useEffect(() => { load() }, [load])

  async function restore(task) {
    const { error } = await supabase.from('tasks').update({ deleted_at: null }).eq('id', task.id)
    if (error) return toast(error.message, true)
    toast(t('restored'))
    load()
    loadTasks()
  }

  return (
    <div className="page">
      <p className="lead">{t('trashHint')}</p>
      {rows.length === 0 && <div className="empty"><Icon name="trash" size={28} /><strong>{t('trashEmpty')}</strong></div>}
      {rows.length > 0 && (
        <div className="sheet">
          {rows.map((x) => (
            <div className="item-row" key={x.id}>
              <div className="item-main">
                <strong>{x.title}</strong>
                <small className="muted">{[deptName(x.department_id), `${t('deletedOn')}: ${new Date(x.deleted_at).toLocaleDateString(lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' })}`].filter(Boolean).join('، ')}</small>
              </div>
              <button className="btn small" onClick={() => restore(x)}>{t('restore')}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Overview() {
  const { t, tasks, people } = useApp()
  const used = useStorageUsed()
  const open = tasks.filter((x) => x.status !== 'done')
  const late = open.filter(isLate)
  const review = open.filter((x) => x.status === 'review')
  const load = people.filter((p) => p.active).map((p) => {
    const mine = open.filter((x) => x.task_assignees.some((a) => a.user_id === p.id))
    return { id: p.id, name: p.full_name, open: mine.length, late: mine.filter(isLate).length }
  }).filter((r) => r.open > 0).sort((a, b) => b.open - a.open)
  const max = Math.max(1, ...load.map((r) => r.open))
  const clear = review.length === 0 && late.length === 0

  return (
    <div className="page">
      <p className="lead">{clear ? t('overviewClear') : fill(t('overviewSum'), { r: review.length, l: late.length, o: open.length })}</p>
      {used !== null && used / FREE_STORAGE_BYTES >= 0.8 && <p className="db-banner">{t('storageWarn')}</p>}
      <div className="overview">
        <div className="stack wide">
          <section className="group">
            <h3 className="strong">{t('needsReview')}<span>{review.length}</span></h3>
            {review.length ? <div className="sheet">{review.map((x) => <TaskRow key={x.id} task={x} />)}</div> : <p className="muted quiet-line">{t('noReview')}</p>}
          </section>
          <section className="group">
            <h3 className="red">{t('lateTasks')}<span>{late.length}</span></h3>
            {late.length ? <div className="sheet">{late.map((x) => <TaskRow key={x.id} task={x} chase />)}</div> : <p className="muted quiet-line">{t('noLate')}</p>}
          </section>
        </div>
        <section className="group">
          <h3>{t('workload')}</h3>
          <div className="sheet pad-sheet">
            {load.length === 0 && <p className="muted">{t('noTasks')}</p>}
            {load.map((r) => (
              <div className="load-row" key={r.id}>
                <Avatar id={r.id} small />
                <div>
                  <div className="load-text"><span>{r.name}</span><b>{r.open}</b></div>
                  <div className="bar"><i style={{ width: `${(r.open / max) * 100}%` }} /><u style={{ width: `${(r.late / max) * 100}%` }} /></div>
                  {r.late > 0 && <small className="late">{r.late} {t('late')}</small>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function PresetForm({ preset, onClose, onSaved }) {
  const { t, me, lang, departments, toast } = useApp()
  const isAdmin = me.role === 'admin'
  const [form, setForm] = useState({
    title: preset?.title || '', description: preset?.description || '', priority: preset?.priority || 'normal',
    department_id: preset ? preset.department_id || '' : me.department_id || '', due_in_days: preset?.due_in_days ?? '',
  })
  const [items, setItems] = useState(preset?.checklist || [])
  const [files, setFiles] = useState([])
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    try {
      const added = []
      for (const file of files) added.push({ file_path: await uploadFile('presets', file), file_name: file.name })
      const row = {
        ...form,
        description: form.description || null,
        department_id: form.department_id || null,
        due_in_days: form.due_in_days === '' ? null : Number(form.due_in_days),
        checklist: items.filter((i) => i.text.trim()),
        attachments: [...(preset?.attachments || []), ...added],
      }
      const { error } = preset
        ? await supabase.from('presets').update(row).eq('id', preset.id)
        : await supabase.from('presets').insert(row)
      if (error) throw error
      onSaved()
    } catch (err) {
      toast(err.message, true)
    }
  }

  return (
    <Drawer
      title={preset ? preset.title : t('newPreset')}
      onClose={onClose}
      footer={<>
        <button className="btn ghost" type="button" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary big" form="preset-form">{t('savePreset')}</button>
      </>}
    >
      <form id="preset-form" className="form-sections" onSubmit={submit}>
        <section>
          <input className="title-input" required autoFocus placeholder={t('title')} aria-label={t('title')} value={form.title} onChange={set('title')} />
          <textarea rows="3" placeholder={`${t('description')} (${t('optional')})`} aria-label={t('description')} value={form.description} onChange={set('description')} />
        </section>
        <section>
          <div>
            <span className="field-label">{t('priority')}</span>
            <PrioritySelect value={form.priority} onChange={(priority) => setForm({ ...form, priority })} />
          </div>
          <div className="grid2">
            <label>{t('daysUntilDue')}<input type="number" min="0" value={form.due_in_days} onChange={set('due_in_days')} /></label>
            <label>{t('department')}
              <select disabled={!isAdmin} value={form.department_id} onChange={set('department_id')}>
                <option value="">{t('companyWide')}</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{lang === 'ar' ? d.name_ar : d.name_en}</option>)}
              </select>
            </label>
          </div>
        </section>
        <section>
          <h3>{t('checklist')}</h3>
          <ChecklistEditor items={items} setItems={setItems} />
        </section>
        <section>
          <label>{t('addFiles')}<input type="file" multiple onChange={(e) => setFiles([...e.target.files])} /></label>
        </section>
      </form>
    </Drawer>
  )
}

function UsePreset({ preset, onClose, onDone }) {
  const { t, me, toast, loadTasks } = useApp()
  const [assignees, setAssignees] = useState([])
  const [separate, setSeparate] = useState(true)
  const [frequency, setFrequency] = useState('')
  const [nextRun, setNextRun] = useState(today())

  async function submit(e) {
    e.preventDefault()
    if (assignees.length === 0) return toast(t('pickAssignee'), true)
    const { error } = frequency
      ? await supabase.from('recurrences').insert({ preset_id: preset.id, assignee_ids: assignees, separate, frequency, next_run: nextRun })
      : await supabase.rpc('create_tasks_from_preset', { p_preset: preset.id, p_assignees: assignees, p_separate: separate, p_creator: me.id })
    if (error) return toast(error.message, true)
    await loadTasks()
    toast(t('created'))
    onDone()
  }

  return (
    <Drawer
      title={preset.title}
      onClose={onClose}
      footer={<>
        <button className="btn ghost" type="button" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary big" form="use-preset">{t('create')}</button>
      </>}
    >
      <form id="use-preset" className="form-sections" onSubmit={submit}>
        <section>
          <h3>{t('whoTitle')}</h3>
          <AssigneePicker selected={assignees} setSelected={setAssignees} separate={separate} setSeparate={setSeparate} department={preset.department_id} />
        </section>
        <section>
          <h3>{t('repeat')}</h3>
          <div className="segmented">
            {[['', t('repeatNone')], ['daily', t('daily')], ['weekly', t('weekly')], ['monthly', t('monthly')]].map(([value, label]) => (
              <button type="button" key={value} className={frequency === value ? 'on' : ''} onClick={() => setFrequency(value)}>{label}</button>
            ))}
          </div>
          {frequency && <label>{t('firstRun')}<input type="date" required min={today()} value={nextRun} onChange={(e) => setNextRun(e.target.value)} /></label>}
        </section>
      </form>
    </Drawer>
  )
}

export function Presets() {
  const { t, me, deptName, toast } = useApp()
  const [presets, setPresets] = useState([])
  const [repeats, setRepeats] = useState([])
  const [editing, setEditing] = useState(null)
  const [using, setUsing] = useState(null)

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      supabase.from('presets').select('*').order('created_at', { ascending: false }),
      supabase.from('recurrences').select('*').eq('active', true).order('next_run'),
    ])
    setPresets(p.data || [])
    setRepeats(r.data || [])
  }, [])
  useEffect(() => { load() }, [load])

  const canEdit = (p) => me.role === 'admin' || (me.role === 'manager' && p.department_id === me.department_id)

  async function remove(p) {
    if (!window.confirm(t('confirmDelete'))) return
    const { error } = await supabase.from('presets').delete().eq('id', p.id)
    if (error) return toast(error.message, true)
    load()
  }

  async function stop(r) {
    const { error } = await supabase.from('recurrences').update({ active: false }).eq('id', r.id)
    if (error) return toast(error.message, true)
    load()
  }

  return (
    <div className="page">
      <div className="page-actions"><button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" />{t('newPreset')}</button></div>
      {presets.length === 0 && <div className="empty"><Icon name="preset" size={28} /><strong>{t('noPresets')}</strong><span>{t('noPresetsHint')}</span></div>}
      {presets.length > 0 && (
        <div className="sheet">
          {presets.map((p) => (
            <div className="item-row" key={p.id}>
              <div className="item-main">
                <strong>{p.title}</strong>
                <small className="muted">{deptName(p.department_id) || t('companyWide')}، {p.checklist.length} {t('items')}{p.due_in_days != null ? `، ${fill(t('dueIn'), { n: p.due_in_days })}` : ''}</small>
              </div>
              <div className="row">
                <button className="btn small primary" onClick={() => setUsing(p)}>{t('use')}</button>
                {canEdit(p) && <button className="btn small" onClick={() => setEditing(p)}>{t('edit')}</button>}
                {canEdit(p) && <button className="icon-btn small" onClick={() => remove(p)} aria-label={t('remove')}><Icon name="trash" size={16} /></button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {repeats.length > 0 && (
        <section className="group">
          <h3><Icon name="repeat" size={16} />{t('repeating')}</h3>
          <div className="sheet">
            {repeats.map((r) => (
              <div className="item-row" key={r.id}>
                <div className="item-main">
                  <strong>{presets.find((p) => p.id === r.preset_id)?.title}</strong>
                  <small className="muted">{t(r.frequency)}، {t('firstRun')}: <span dir="ltr">{r.next_run}</span></small>
                </div>
                <button className="btn small" onClick={() => stop(r)}>{t('stop')}</button>
              </div>
            ))}
          </div>
        </section>
      )}
      {editing && <PresetForm preset={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
      {using && <UsePreset preset={using} onClose={() => setUsing(null)} onDone={() => { setUsing(null); load() }} />}
    </div>
  )
}

export function Projects() {
  const { t, projects, tasks, departments, lang, me, toast, loadRefs, deptName } = useApp()
  const [form, setForm] = useState({ name: '', code: '', deadline: '', department_id: me.department_id || '' })
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  async function add(e) {
    e.preventDefault()
    const { error } = await supabase.from('projects').insert({
      name: form.name.trim(), code: form.code || null, deadline: form.deadline || null, department_id: form.department_id || null,
    })
    if (error) return toast(error.message, true)
    setForm({ ...form, name: '', code: '', deadline: '' })
    loadRefs()
  }

  async function archive(p) {
    const { error } = await supabase.from('projects').update({ archived: true }).eq('id', p.id)
    if (error) return toast(error.message, true)
    loadRefs()
  }

  const list = projects.filter((p) => !p.archived)
  return (
    <div className="page">
      <form className="inline-form" onSubmit={add}>
        <label className="grow">{t('projectName')}<input required value={form.name} onChange={set('name')} /></label>
        <label>{t('code')}<input value={form.code} onChange={set('code')} /></label>
        <label>{t('deadline')}<input type="date" value={form.deadline} onChange={set('deadline')} /></label>
        <label>{t('department')}
          <select value={form.department_id} onChange={set('department_id')}>
            <option value="">{t('none')}</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{lang === 'ar' ? d.name_ar : d.name_en}</option>)}
          </select>
        </label>
        <button className="btn primary">{t('addProject')}</button>
      </form>
      {list.length === 0 && <div className="empty"><Icon name="project" size={28} /><strong>{t('noProjects')}</strong><span>{t('noProjectsHint')}</span></div>}
      {list.length > 0 && (
        <div className="sheet">
          {list.map((p) => {
            const open = tasks.filter((x) => x.project_id === p.id && x.status !== 'done').length
            return (
              <div className="item-row" key={p.id}>
                <div className="item-main">
                  <strong>{p.name}{p.code && <span className="code" dir="ltr">{p.code}</span>}</strong>
                  <small className="muted">{[deptName(p.department_id), p.deadline && `${t('deadline')}: ${p.deadline}`, `${open} ${t('openTasks')}`].filter(Boolean).join('، ')}</small>
                </div>
                <button className="btn small" onClick={() => archive(p)}>{t('archive')}</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AddPerson({ onClose, onAdded }) {
  const { t, lang, departments, toast } = useApp()
  const [form, setForm] = useState({ username: '', full_name: '', password: tempPassword(), phone: '', role: 'employee', department_id: '' })
  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  async function add(e) {
    e.preventDefault()
    const username = form.username.trim().toLowerCase()
    if (!/^[a-z0-9._-]+$/.test(username)) return toast(t('usernameRule'), true)
    if (form.password.length < 6) return toast(t('passwordRule'), true)
    if (form.phone.trim() && !whatsappNumber(form.phone)) return toast(t('phoneInvalid'), true)
    setBusy(true)
    try {
      await createAccount({ ...form, username, full_name: form.full_name.trim(), phone: form.phone.trim() })
    } catch (err) {
      setBusy(false)
      return toast(err.message, true)
    }
    setBusy(false)
    onAdded()
    setCreated({ username, password: form.password, name: form.full_name.trim() })
  }

  async function copy() {
    await navigator.clipboard.writeText(`${t('appName')}\n${location.origin}\n${t('username')}: ${created.username}\n${t('password')}: ${created.password}`)
    toast(t('copied'))
  }

  if (created) {
    return (
      <Modal title={t('addPerson')} onClose={onClose}>
        <div className="stack">
          <p>{fill(t('accountReady'), { name: created.name })}</p>
          <dl className="credentials">
            <div><dt>{t('username')}</dt><dd dir="ltr">{created.username}</dd></div>
            <div><dt>{t('password')}</dt><dd dir="ltr">{created.password}</dd></div>
          </dl>
          <div className="row end">
            <button className="btn ghost" onClick={copy}>{t('copy')}</button>
            <button className="btn primary" onClick={onClose}>{t('done_btn')}</button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Drawer
      title={t('addPerson')}
      onClose={onClose}
      footer={<>
        <button className="btn ghost" type="button" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary big" form="person-form" disabled={busy}>{t('addPerson')}</button>
      </>}
    >
      <form id="person-form" className="form-sections" onSubmit={add}>
        <section>
          <label>{t('fullName')}<input required autoFocus value={form.full_name} onChange={set('full_name')} /></label>
          <label>{t('username')}<input required dir="ltr" autoComplete="off" value={form.username} onChange={set('username')} /><small className="muted">{t('usernameRule')}</small></label>
          <label>{t('tempPassword')}<input required dir="ltr" type="text" autoComplete="off" value={form.password} onChange={set('password')} /><small className="muted">{t('tempPasswordHint')}</small></label>
          <label>{t('phone')} <small className="muted">({t('optional')})</small><input dir="ltr" type="tel" autoComplete="off" value={form.phone} onChange={set('phone')} /><small className="muted">{t('phoneHint')}</small></label>
        </section>
        <section>
          <div>
            <span className="field-label">{t('role')}</span>
            <div className="segmented">
              {['employee', 'manager', 'admin'].map((r) => (
                <button type="button" key={r} className={form.role === r ? 'on' : ''} onClick={() => setForm({ ...form, role: r })}>{t(r)}</button>
              ))}
            </div>
          </div>
          <label>{t('department')}
            <select value={form.department_id} onChange={set('department_id')}>
              <option value="">{t('none')}</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{lang === 'ar' ? d.name_ar : d.name_en}</option>)}
            </select>
          </label>
        </section>
      </form>
    </Drawer>
  )
}

function PasswordLine({ value }) {
  const { t, toast } = useApp()
  const [shown, setShown] = useState(false)
  if (!value) return <small className="muted">{t('passwordNotSet')}</small>
  async function copy() {
    await navigator.clipboard.writeText(value)
    toast(t('copied'))
  }
  return (
    <small className="password-line">
      <span dir="ltr">{shown ? value : '••••••••'}</span>
      <button type="button" className="link" onClick={() => setShown(!shown)}>{shown ? t('hidePassword') : t('showPassword')}</button>
      {shown && <button type="button" className="link" onClick={copy}>{t('copy')}</button>}
    </small>
  )
}

function ResetPassword({ person, onClose }) {
  const { t, toast } = useApp()
  const [password, setPassword] = useState(tempPassword)
  async function submit(e) {
    e.preventDefault()
    if (password.length < 6) return toast(t('passwordRule'), true)
    const { error } = await supabase.rpc('admin_set_password', { p_user: person.id, p_password: password })
    if (error) return toast(error.message, true)
    toast(t('saved'))
    onClose()
  }
  return (
    <Modal title={person.full_name} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>{t('tempPassword')}<input dir="ltr" type="text" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /><small className="muted">{t('tempPasswordHint')}</small></label>
        <button className="btn primary">{t('setPassword')}</button>
      </form>
    </Modal>
  )
}

export function People() {
  const { t, me, people, departments, toast, loadRefs, deptName } = useApp()
  const used = useStorageUsed()
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [resetting, setResetting] = useState(null)
  const [passwords, setPasswords] = useState({})

  const loadPasswords = useCallback(async () => {
    const { data } = await supabase.from('account_passwords').select('*')
    setPasswords(Object.fromEntries((data || []).map((r) => [r.user_id, r.password])))
  }, [])
  useEffect(() => { loadPasswords() }, [loadPasswords, people])
  const [dept, setDept] = useState({ name_ar: '', name_en: '' })

  async function update(p, patch) {
    const { error } = await supabase.from('profiles').update(patch).eq('id', p.id)
    if (error) return toast(error.message, true)
    toast(t('saved'))
    loadRefs()
  }

  function savePhone(p, value) {
    const phone = value.trim()
    if (phone === (p.phone || '')) return
    if (phone && !whatsappNumber(phone)) return toast(t('phoneInvalid'), true)
    update(p, { phone: phone || null })
  }

  async function addDept(e) {
    e.preventDefault()
    const { error } = await supabase.from('departments').insert(dept)
    if (error) return toast(error.message, true)
    setDept({ name_ar: '', name_en: '' })
    loadRefs()
  }

  return (
    <div className="page">
      <div className="page-actions row">
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('addPerson')}</button>
        <button className="btn" onClick={() => setImporting(true)}><Icon name="people" />{t('importStaff')}</button>
      </div>
      <div className="sheet">
        {people.map((p) => (
          <div className={`person-row ${p.active ? '' : 'off'}`} key={p.id}>
            <Avatar id={p.id} />
            <div className="item-main">
              <strong>{p.full_name}{!p.active && <span className="pill">{t('inactive')}</span>}</strong>
              <small className="muted" dir="ltr">{p.username}</small>
              <PasswordLine value={passwords[p.id]} />
            </div>
            <input
              key={p.phone || 'none'}
              className="phone-input"
              dir="ltr"
              type="tel"
              placeholder={t('phone')}
              aria-label={`${t('phone')}: ${p.full_name}`}
              defaultValue={p.phone || ''}
              onBlur={(e) => savePhone(p, e.target.value)}
            />
            <select disabled={p.id === me.id} value={p.role} onChange={(e) => update(p, { role: e.target.value })} aria-label={t('role')}>
              {['employee', 'manager', 'admin'].map((r) => <option key={r} value={r}>{t(r)}</option>)}
            </select>
            <select value={p.department_id || ''} onChange={(e) => update(p, { department_id: e.target.value || null })} aria-label={t('department')}>
              <option value="">{t('none')}</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{deptName(d.id)}</option>)}
            </select>
            <div className="row">
              <button className="btn small" onClick={() => setResetting(p)}>{t('resetPassword')}</button>
              {p.id !== me.id && <button className="btn small" onClick={() => update(p, { active: !p.active })}>{p.active ? t('deactivate') : t('activate')}</button>}
            </div>
          </div>
        ))}
      </div>
      <section className="group">
        <h3>{t('departments')}<span>{departments.length}</span></h3>
        <div className="dept-list">{departments.map((d) => <span key={d.id}>{deptName(d.id)}</span>)}</div>
        <form className="inline-form" onSubmit={addDept}>
          <label className="grow">{t('nameAr')}<input required value={dept.name_ar} onChange={(e) => setDept({ ...dept, name_ar: e.target.value })} /></label>
          <label className="grow">{t('nameEn')}<input required dir="ltr" value={dept.name_en} onChange={(e) => setDept({ ...dept, name_en: e.target.value })} /></label>
          <button className="btn">{t('addDepartment')}</button>
        </form>
      </section>
      <StorageMeter used={used} />
      {adding && <AddPerson onClose={() => setAdding(false)} onAdded={loadRefs} />}
      {importing && <ImportStaff onClose={() => setImporting(false)} onDone={loadRefs} />}
      {resetting && <ResetPassword person={resetting} onClose={() => { setResetting(null); loadPasswords() }} />}
    </div>
  )
}
