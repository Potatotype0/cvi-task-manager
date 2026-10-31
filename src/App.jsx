import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppContext, TASK_SELECT, canManage, canWork, dict, emailOf, fill, isReady, supabase, useApp } from './lib.js'
import { disablePush, enablePush, isInstalled, pushState, refreshPush } from './push.js'
import { InstallGuide, NotificationPrompt, shouldOfferInstall } from './setup.jsx'
import { Avatar, Modal, MyTasks, Board, Palette, TaskDetail, TaskForm } from './tasks.jsx'
import { Overview, People, Presets, Projects, Trash } from './pages.jsx'
import { Reports } from './reports.jsx'
import { Icon } from './icons.jsx'
import logo from './assets/logo.png'

function useLang() {
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem('cvi-lang') || 'ar' } catch { return 'ar' }
  })
  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    try { localStorage.setItem('cvi-lang', lang) } catch {}
  }, [lang])
  return [lang, setLang]
}

function useClickOutside(onOutside) {
  const ref = useRef(null)
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onOutside])
  return ref
}

function Login({ lang, setLang, notice }) {
  const t = (k) => dict[lang][k]
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(notice || '')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: emailOf(username), password })
    if (error) setError(t('loginFailed'))
    setBusy(false)
  }

  return (
    <div className="login">
      <div className="login-side">
        <form className="login-form" onSubmit={submit}>
          <img className="login-logo" src={logo} alt="CVI ARCH" />
          <p className="muted">{t('loginTag')}</p>
          <p className="login-intro">{t('loginIntro')}</p>
          <label>{t('username')}<input dir="ltr" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label>{t('password')}<input dir="ltr" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn primary big" disabled={busy}>{t('login')}</button>
          <button type="button" className="link quiet" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{t('language')}</button>
        </form>
      </div>
    </div>
  )
}

function Bell() {
  const { t, lang, me, openTask, loadTasks } = useApp()
  const [items, setItems] = useState([])
  const noteText = (n) => {
    const parts = (n.detail || '').split('|')
    return fill(t(`n_${n.kind}`), { 0: parts[0], 1: parts[1], 2: parts[2] })
  }
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useClickOutside(close)

  const load = useCallback(async () => {
    const { data } = await supabase.from('notifications').select('*, tasks(title)').eq('user_id', me.id)
      .order('created_at', { ascending: false }).limit(30)
    setItems(data || [])
  }, [me.id])

  useEffect(() => {
    load()
    const channel = supabase.channel('my-notifications')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${me.id}` }, () => {
        load()
        loadTasks()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [me.id, load, loadTasks])

  const toggle = () => setOpen(!open)

  async function markAll() {
    await supabase.from('notifications').update({ read: true }).eq('user_id', me.id).eq('read', false)
    load()
  }

  async function click(n) {
    await supabase.from('notifications').update({ read: true }).eq('id', n.id)
    load()
    setOpen(false)
    if (n.task_id) openTask(n.task_id)
  }

  const unread = items.filter((n) => !n.read).length
  return (
    <div className="pop-wrap" ref={ref}>
      <button className="icon-btn" onClick={toggle} aria-label={t('notifications')} aria-expanded={open}>
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="dot-count">{unread}</span>}
      </button>
      {open && (
        <div className="pop notes">
          <div className="pop-head">
            <strong>{t('notifications')}</strong>
            {unread > 0 && <button className="link" onClick={markAll}>{t('markRead')}</button>}
          </div>
          {items.length === 0 && <p className="muted pad">{t('noNotifications')}</p>}
          {items.map((n) => (
            <button key={n.id} className={`note ${n.read ? '' : 'unread'}`} onClick={() => click(n)}>
              <span>{noteText(n)}{n.tasks?.title && <em>{n.tasks.title}</em>}</span>
              <small>{new Date(n.created_at).toLocaleString(lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AccountMenu({ setLang, onChangePassword, onInstall, onPushChange }) {
  const { t, lang, me, deptName, toast } = useApp()
  const [open, setOpen] = useState(false)
  const [push, setPush] = useState(null)
  const close = useCallback(() => setOpen(false), [])
  const ref = useClickOutside(close)

  useEffect(() => {
    if (open) pushState().then(setPush).catch(() => setPush('unsupported'))
  }, [open])

  async function togglePush() {
    setOpen(false)
    try {
      if (push === 'on') {
        await disablePush()
        toast(t('notifyOff'))
      } else {
        const on = await enablePush(lang)
        toast(on ? t('notifyOn') : t('notifyBlocked'), !on)
      }
      onPushChange()
    } catch (err) {
      toast(err.message, true)
    }
  }

  async function logout() {
    await disablePush().catch(() => {})
    await supabase.auth.signOut()
  }

  return (
    <div className="pop-wrap" ref={ref}>
      <button className="account-btn" onClick={() => setOpen(!open)} aria-label={t('menu')} aria-expanded={open}>
        <Avatar id={me.id} />
        <span className="account-name">{me.full_name}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="pop menu">
          <div className="pop-head column">
            <strong>{me.full_name}</strong>
            <small className="muted">{t(me.role)}{me.department_id ? `، ${deptName(me.department_id)}` : ''}</small>
          </div>
          <button onClick={() => { setLang(lang === 'ar' ? 'en' : 'ar'); setOpen(false) }}>{t('language')}</button>
          {['on', 'off'].includes(push) && <button onClick={togglePush}>{push === 'on' ? t('notifyTurnOff') : t('notifyTurnOn')}</button>}
          {push === 'blocked' && <p className="menu-note">{t('notifyBlocked')}</p>}
          {!isInstalled() && <button onClick={() => { onInstall(); setOpen(false) }}>{t('installTitle')}</button>}
          <button onClick={() => { onChangePassword(); setOpen(false) }}>{t('changePassword')}</button>
          <button onClick={logout}>{t('logout')}</button>
        </div>
      )}
    </div>
  )
}

function ChangePassword({ onClose }) {
  const { t, toast } = useApp()
  const [password, setPassword] = useState('')
  async function submit(e) {
    e.preventDefault()
    if (password.length < 6) return toast(t('passwordRule'), true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) return toast(error.message, true)
    toast(t('saved'))
    onClose()
  }
  return (
    <Modal title={t('changePassword')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>{t('newPassword')}<input dir="ltr" type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="btn primary">{t('save')}</button>
      </form>
    </Modal>
  )
}

function Shell({ me, lang, setLang, refreshMe }) {
  const t = useCallback((k) => dict[lang][k] ?? k, [lang])
  const isManager = me.role === 'admin' || me.role === 'manager'
  const [view, setView] = useState(isManager ? 'overview' : 'my')
  const [departments, setDepartments] = useState([])
  const [people, setPeople] = useState([])
  const [projects, setProjects] = useState([])
  const [tasks, setTasks] = useState([])
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [changingPw, setChangingPw] = useState(false)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState(shouldOfferInstall)
  const [pushVersion, setPushVersion] = useState(0)
  const [message, setMessage] = useState(null)
  const [needsDbUpdate, setNeedsDbUpdate] = useState(false)

  const toast = useCallback((text, bad = false) => {
    const known = { FILE_TOO_BIG: 'fileTooBig' }
    setMessage({ text: known[text] ? t(known[text]) : text, bad })
    setTimeout(() => setMessage(null), 4000)
  }, [t])

  const loadTasks = useCallback(async () => {
    const { data, error } = await supabase.from('tasks').select(TASK_SELECT).is('deleted_at', null).order('created_at', { ascending: false })
    setNeedsDbUpdate(Boolean(error))
    if (!error) setTasks(data)
  }, [])

  // Updates the screen first so it feels instant, then undoes it if the database refuses.
  const moveTask = useCallback(async (task, status) => {
    if (['review', 'done'].includes(status) && task.status !== 'review' && !isReady(task.checklist_items)) {
      toast(t('finishChecklist'), true)
      setOpenId(task.id)
      return
    }
    setTasks((list) => list.map((x) => (x.id === task.id ? { ...x, status } : x)))
    const { error } = await supabase.from('tasks').update({ status }).eq('id', task.id)
    if (error) {
      toast(error.message.startsWith('Finish') ? t('finishChecklist') : error.message, true)
      loadTasks()
    }
  }, [t, toast, loadTasks])

  const dropTask = useCallback((task, column) => {
    const inColumn = column === task.status || (column === 'todo' && task.status === 'returned')
    if (inColumn) return
    const manage = canManage(task, me)
    const refused = !canWork(task, me)
      || (column === 'todo' && !manage)
      || (task.status === 'done' && !manage)
    if (refused) return toast(t('onlyManagerMove'), true)
    const finishing = column === 'done' || (column === 'review' && !task.needs_approval)
    if (finishing && task.needs_approval && !manage) return toast(t('needsManager'), true)
    moveTask(task, finishing ? 'done' : column)
  }, [me, t, toast, moveTask])

  const loadRefs = useCallback(async () => {
    const [d, p, pr] = await Promise.all([
      supabase.from('departments').select('*').order('created_at'),
      supabase.from('profiles').select('*').order('full_name'),
      supabase.from('projects').select('*').order('created_at', { ascending: false }),
    ])
    setDepartments(d.data || [])
    setPeople(p.data || [])
    setProjects(pr.data || [])
    refreshMe()
  }, [refreshMe])

  useEffect(() => {
    loadRefs()
    loadTasks()
    const channel = supabase.channel('tasks-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => loadTasks())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadRefs, loadTasks])

  const deptName = useCallback((id) => {
    const d = departments.find((x) => x.id === id)
    return d ? (lang === 'ar' ? d.name_ar : d.name_en) : ''
  }, [departments, lang])
  const personName = useCallback((id) => people.find((p) => p.id === id)?.full_name || '', [people])

  const ctx = useMemo(() => ({
    t, lang, me, isManager, departments, people, projects, tasks, deptName, personName, toast, loadTasks, loadRefs, moveTask, dropTask,
    openTask: setOpenId, openNewTask: () => setCreating(true),
  }), [t, lang, me, isManager, departments, people, projects, tasks, deptName, personName, toast, loadTasks, loadRefs, moveTask, dropTask])

  const myOpen = tasks.filter((x) => x.status !== 'done' && x.status !== 'review' && x.task_assignees.some((a) => a.user_id === me.id)).length
  const toReview = tasks.filter((x) => x.status === 'review').length

  const nav = [
    ...(isManager ? [['overview', t('overview'), 'overview', toReview]] : []),
    ['my', t('myTasks'), 'list', myOpen],
    ['board', t('board'), 'board'],
    ['reports', isManager ? t('reports') : t('myNumbers'), 'report'],
    ...(isManager ? [['presets', t('presets'), 'preset'], ['projects', t('projects'), 'project']] : []),
    ...(me.role === 'admin' ? [['people', t('people'), 'people']] : []),
    ...(isManager ? [['trash', t('trash'), 'trash']] : []),
  ]

  useEffect(() => { refreshPush(lang).catch(() => {}) }, [lang, me.id])

  // Tapping a notification opens its task, whether the app was closed or already open.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('task')) {
      setOpenId(params.get('task'))
      history.replaceState(null, '', location.pathname)
    }
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e) => { if (e.data?.openTask) setOpenId(e.data.openTask) }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  // Key codes, not letters, so shortcuts also work on an Arabic keyboard layout.
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault()
        setSearching(true)
        return
      }
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable
      if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.overlay')) return
      if (e.code === 'KeyN') {
        e.preventDefault()
        setCreating(true)
      }
      const digit = e.code.match(/^Digit([1-9])$/)
      if (digit && nav[digit[1] - 1]) setView(nav[digit[1] - 1][0])
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  })

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <aside className="side">
          <img className="side-logo" src={logo} alt="CVI ARCH" />
          <button className="btn primary new-task" onClick={() => setCreating(true)}><Icon name="plus" />{t('newTask')}</button>
          <nav>
            {nav.map(([id, label, icon, count]) => (
              <button key={id} className={view === id ? 'on' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
                <Icon name={icon} size={19} />
                <span>{label}</span>
                {count > 0 && <em>{count}</em>}
              </button>
            ))}
          </nav>
        </aside>
        <div className="main-col">
          <header className="top">
            <h1>{nav.find(([id]) => id === view)?.[1]}</h1>
            <div className="top-tools">
              <button className="search-btn" onClick={() => setSearching(true)} aria-label={t('searchAll')}>
                <Icon name="search" /><span>{t('searchAll')}</span><kbd dir="ltr">Ctrl K</kbd>
              </button>
              <Bell />
              <AccountMenu
                setLang={setLang}
                onChangePassword={() => setChangingPw(true)}
                onInstall={() => setInstalling(true)}
                onPushChange={() => setPushVersion((v) => v + 1)}
              />
            </div>
          </header>
          <main className="main">
            {needsDbUpdate && <p className="db-banner" role="alert">{t('dbUpdate')}</p>}
            <NotificationPrompt onInstall={() => setInstalling(true)} version={pushVersion} />
            {view === 'overview' && <Overview />}
            {view === 'my' && <MyTasks />}
            {view === 'board' && <Board />}
            {view === 'reports' && <Reports />}
            {view === 'presets' && <Presets />}
            {view === 'projects' && <Projects />}
            {view === 'people' && <People />}
            {view === 'trash' && <Trash />}
          </main>
        </div>
      </div>
      <button className="fab" onClick={() => setCreating(true)} aria-label={t('newTask')}><Icon name="plus" size={24} /></button>
      {searching && <Palette views={nav} onView={setView} onClose={() => setSearching(false)} />}
      {creating && <TaskForm onClose={() => setCreating(false)} />}
      {openId && <TaskDetail id={openId} onClose={() => setOpenId(null)} />}
      {changingPw && <ChangePassword onClose={() => setChangingPw(false)} />}
      {installing && <InstallGuide onClose={() => setInstalling(false)} />}
      {message && <div className={`toast ${message.bad ? 'bad' : ''}`} role="status">{message.text}</div>}
    </AppContext.Provider>
  )
}

export default function App() {
  const [lang, setLang] = useLang()
  const [session, setSession] = useState(undefined)
  const [me, setMe] = useState(null)
  const [notice, setNotice] = useState('')
  const userId = session?.user?.id

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const refreshMe = useCallback(async () => {
    if (!userId) return setMe(null)
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    if (!data || !data.active) {
      setNotice(dict[lang].disabled)
      await supabase.auth.signOut()
      return
    }
    setMe(data)
  }, [userId])

  useEffect(() => { refreshMe() }, [refreshMe])

  if (session === undefined) return null
  if (!session) return <Login lang={lang} setLang={setLang} notice={notice} />
  if (!me) return null
  return <Shell me={me} lang={lang} setLang={setLang} refreshMe={refreshMe} />
}
