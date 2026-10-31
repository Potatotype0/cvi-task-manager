import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { canMarkUp, MarkupEditor } from './markup.jsx'
import { canManage, canWork, createTasks, dateAfter, daysFromToday, downloadFile, dueLabel, fill, formatDate, isLate, isReady, nextAction, openFile, supabase, taskLink, today, uploadFile, useApp, whatsappLink } from './lib.js'
import { Icon } from './icons.jsx'

function useEscape(onClose) {
  useEffect(() => {
    // The markup screen sits on top, and Escape must not throw away someone's drawing.
    const handler = (e) => { if (e.key === 'Escape' && !document.querySelector('.markup')) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])
}

export function Modal({ title, onClose, children }) {
  const { t } = useApp()
  useEscape(onClose)
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('cancel')}><Icon name="close" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Drawer({ title, onClose, children, footer, tools }) {
  const { t } = useApp()
  useEscape(onClose)
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <div className="row">
            {tools}
            <button className="icon-btn" onClick={onClose} aria-label={t('cancel')}><Icon name="close" /></button>
          </div>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  )
}

const avatarTones = ['#1f1f1f', '#4a4a4a', '#6b6b6b', '#333a40', '#55504a', '#3e3e46']
export function Avatar({ id, small }) {
  const { people } = useApp()
  const person = people.find((p) => p.id === id)
  const name = person?.full_name || '?'
  const tone = avatarTones[[...String(id)].reduce((sum, c) => sum + c.charCodeAt(0), 0) % avatarTones.length]
  return <span className={`avatar ${small ? 'small' : ''}`} style={{ background: tone }} title={name}>{name.trim().charAt(0)}</span>
}

export function StatusPill({ status }) {
  const { t } = useApp()
  return <span className={`pill s-${status}`}>{t(status)}</span>
}

function Progress({ items }) {
  if (!items?.length) return <span />
  const done = items.filter((i) => i.done).length
  return (
    <span className="progress" title={`${done}/${items.length}`}>
      <i><b style={{ width: `${(done / items.length) * 100}%` }} /></i>
      <small dir="ltr">{done}/{items.length}</small>
    </span>
  )
}

// One-tap next step. Unfinished checklists open the task so the person can see what is missing.
function ActionButton({ task }) {
  const { t, me, moveTask } = useApp()
  const action = nextAction(task, me)
  if (!action) return <span />
  return (
    <button className="btn small act" onClick={(e) => { e.stopPropagation(); moveTask(task, action.status) }}>
      {t(action.label)}
    </button>
  )
}

// Opens WhatsApp with a ready message in the sender's language. The sender still taps send.
export function WhatsAppLink({ personId, task, kind = 'task', labelled, children }) {
  const { t, lang, people } = useApp()
  const person = people.find((p) => p.id === personId)
  const lines = [fill(t(`wa_${kind}`), { name: person?.full_name.split(' ')[0] || '', title: task.title })]
  if (task.due_date) lines.push(fill(t('wa_due'), { due: formatDate(task.due_date, lang) }))
  lines.push(taskLink(task.id))
  const href = whatsappLink(person?.phone, lines.join('\n'))
  if (!href) return null
  return (
    <a
      className={labelled ? 'btn small' : 'wa-link'}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${t('sendWhatsapp')}: ${person.full_name}`}
      aria-label={`${t('sendWhatsapp')}: ${person.full_name}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Icon name="chat" size={labelled ? 15 : 17} />
      {labelled && t('sendWhatsapp')}
      {children}
    </a>
  )
}

export function TaskRow({ task, selectable, selected, onSelect, chase }) {
  const { t, lang, openTask, projects, deptName } = useApp()
  const project = projects.find((p) => p.id === task.project_id)
  return (
    <div className={`task-row pr-${task.priority} ${selected ? 'picked' : ''} ${selectable !== undefined ? 'with-check' : ''}`} onClick={() => openTask(task.id)}>
      {selectable !== undefined && (
        <span className="row-check" onClick={(e) => e.stopPropagation()}>
          {selectable && <input type="checkbox" aria-label={task.title} checked={selected} onChange={() => onSelect(task.id)} />}
        </span>
      )}
      <button className="task-main" onClick={(e) => { e.stopPropagation(); openTask(task.id) }}>
        <strong>{task.title}</strong>
        <small>{project?.name || deptName(task.department_id)}</small>
      </button>
      <Progress items={task.checklist_items} />
      <span className={`due ${isLate(task) ? 'late' : ''}`}>{dueLabel(task, t, lang)}</span>
      <span className="stack-avatars">
        {task.task_assignees.slice(0, 3).map((a) => (
          chase
            ? <WhatsAppLink key={a.user_id} personId={a.user_id} task={task} kind="late" />
            : <Avatar key={a.user_id} id={a.user_id} small />
        ))}
      </span>
      <StatusPill status={task.status} />
      <ActionButton task={task} />
    </div>
  )
}

function Group({ title, tone, tasks }) {
  if (tasks.length === 0) return null
  return (
    <section className="group">
      <h3 className={tone}>{title}<span>{tasks.length}</span></h3>
      <div className="sheet">{tasks.map((x) => <TaskRow key={x.id} task={x} />)}</div>
    </section>
  )
}

function QuickAdd() {
  const { t, me, isManager, people, toast, loadTasks, openNewTask } = useApp()
  const [title, setTitle] = useState('')
  const [person, setPerson] = useState(me.id)
  const [busy, setBusy] = useState(false)
  const [justMade, setJustMade] = useState(null)
  const input = useRef(null)

  async function submit(e) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    const assignee = people.find((p) => p.id === person)
    const department_id = me.role === 'admin' ? assignee?.department_id ?? null : me.department_id
    try {
      const [made] = await createTasks({
        fields: { title: title.trim(), department_id, needs_approval: isManager && person !== me.id },
        assignees: [person],
      })
      setJustMade(person !== me.id && assignee?.phone ? { task: made, person } : null)
      setTitle('')
      await loadTasks()
      input.current?.focus()
    } catch (err) {
      toast(err.message, true)
    }
    setBusy(false)
  }

  return (
    <div className="stack tight">
      <form className="quick-add" onSubmit={submit}>
        <Icon name="plus" />
        <input ref={input} placeholder={t('quickAddPlaceholder')} aria-label={t('quickAddPlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
        {isManager && (
          <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label={t('assignees')}>
            <option value={me.id}>{t('quickForMe')}</option>
            {people.filter((p) => p.active && p.id !== me.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        )}
        <button type="button" className="link quiet" onClick={openNewTask}>{t('moreDetails')}</button>
      </form>
      {justMade && (
        <div className="tell-bar">
          <span>{t('created')}: {justMade.task.title}</span>
          <WhatsAppLink personId={justMade.person} task={justMade.task} kind="assigned" labelled />
          <button className="icon-btn small" onClick={() => setJustMade(null)} aria-label={t('cancel')}><Icon name="close" size={15} /></button>
        </div>
      )}
    </div>
  )
}

export function MyTasks() {
  const { t, tasks, me } = useApp()
  const [showDone, setShowDone] = useState(false)
  const mine = tasks.filter((x) => x.task_assignees.some((a) => a.user_id === me.id))
  const open = mine.filter((x) => x.status !== 'done' && x.status !== 'review')
  const byDue = (a, b) => (a.due_date || '9').localeCompare(b.due_date || '9')
  const n = (x) => daysFromToday(x.due_date)

  const returned = open.filter((x) => x.status === 'returned')
  const rest = open.filter((x) => x.status !== 'returned').sort(byDue)
  const late = rest.filter((x) => x.due_date && n(x) < 0)
  const dueToday = rest.filter((x) => x.due_date && n(x) === 0)
  const week = rest.filter((x) => x.due_date && n(x) > 0 && n(x) <= 7)
  const later = rest.filter((x) => x.due_date && n(x) > 7)
  const noDate = rest.filter((x) => !x.due_date)
  const inReview = mine.filter((x) => x.status === 'review')
  const done = mine.filter((x) => x.status === 'done')

  let summary = t('sumNone')
  if (open.length) {
    const lateAll = open.filter(isLate).length
    summary = fill(t('sumOpen'), { n: open.length })
      + (lateAll ? fill(t('sumLate'), { n: lateAll }) : '')
      + (dueToday.length ? fill(t('sumToday'), { n: dueToday.length }) : '') + '.'
  }

  return (
    <div className="page">
      <p className="lead">{t('hello')} {me.full_name.split(' ')[0]}. {summary}</p>
      <QuickAdd />
      {open.length === 0 && inReview.length === 0 && (
        <div className="empty"><Icon name="check" size={28} /><strong>{t('allClear')}</strong><span>{t('allClearHint')}</span></div>
      )}
      <Group title={t('g_returned')} tone="red" tasks={returned} />
      <Group title={t('g_late')} tone="red" tasks={late} />
      <Group title={t('g_today')} tasks={dueToday} />
      <Group title={t('g_week')} tasks={week} />
      <Group title={t('g_later')} tasks={later} />
      <Group title={t('g_nodate')} tasks={noDate} />
      <Group title={t('review')} tasks={inReview} />
      {done.length > 0 && <button className="link quiet start" onClick={() => setShowDone(!showDone)}>{t('showDone')} ({done.length})</button>}
      {showDone && <Group title={t('g_done')} tasks={done} />}
    </div>
  )
}

const columns = [
  ['todo', ['todo', 'returned']],
  ['in_progress', ['in_progress']],
  ['review', ['review']],
  ['done', ['done']],
]

function BoardColumns({ shown }) {
  const { t, lang, openTask, projects, dropTask } = useApp()
  const [over, setOver] = useState(null)
  return (
    <div className="board">
      {columns.map(([key, statuses]) => {
        const list = shown.filter((x) => statuses.includes(x.status))
        return (
          <section
            key={key}
            className={`col ${over === key ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(key) }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null) }}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const task = shown.find((x) => x.id === e.dataTransfer.getData('text/plain'))
              if (task) dropTask(task, key)
            }}
          >
            <h3>{t(key)}<span>{list.length}</span></h3>
            <div className="col-cards">
              {list.map((x) => (
                <div
                  className={`card-task pr-${x.priority}`}
                  key={x.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', x.id)}
                  onClick={() => openTask(x.id)}
                >
                  {x.status === 'returned' && <StatusPill status="returned" />}
                  <button className="card-title" onClick={(e) => { e.stopPropagation(); openTask(x.id) }}>{x.title}</button>
                  {x.project_id && <small className="muted">{projects.find((p) => p.id === x.project_id)?.name}</small>}
                  <Progress items={x.checklist_items} />
                  <span className="card-foot">
                    <span className={`due ${isLate(x) ? 'late' : ''}`}>{dueLabel(x, t, lang)}</span>
                    <span className="stack-avatars">{x.task_assignees.slice(0, 3).map((a) => <Avatar key={a.user_id} id={a.user_id} small />)}</span>
                  </span>
                  <ActionButton task={x} />
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function BulkBar({ ids, clear }) {
  const { t, people, toast, loadTasks } = useApp()

  async function patch(fields) {
    const { error } = await supabase.from('tasks').update(fields).in('id', ids)
    if (error) return toast(error.message, true)
    await loadTasks()
    toast(t('saved'))
  }

  async function reassign(user_id) {
    if (!user_id) return
    try {
      for (const task_id of ids) {
        const removed = await supabase.from('task_assignees').delete().eq('task_id', task_id)
        if (removed.error) throw removed.error
        const added = await supabase.from('task_assignees').insert({ task_id, user_id })
        if (added.error) throw added.error
      }
      await patch({ is_shared: false })
    } catch (err) {
      toast(err.message, true)
    }
  }

  async function trash() {
    await patch({ deleted_at: new Date().toISOString() })
    clear()
  }

  return (
    <div className="bulk-bar" role="toolbar">
      <strong>{ids.length} {t('selected')}</strong>
      <select value="" onChange={(e) => reassign(e.target.value)} aria-label={t('reassign')}>
        <option value="">{t('reassign')}</option>
        {people.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
      </select>
      <label className="bulk-date">{t('changeDate')}<input type="date" value="" onChange={(e) => e.target.value && patch({ due_date: e.target.value })} /></label>
      <select value="" onChange={(e) => e.target.value && patch({ priority: e.target.value })} aria-label={t('changePriority')}>
        <option value="">{t('changePriority')}</option>
        {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{t(p)}</option>)}
      </select>
      <button className="icon-btn" onClick={trash} aria-label={t('remove')} title={t('remove')}><Icon name="trash" /></button>
      <button className="link quiet" onClick={clear}>{t('clear')}</button>
    </div>
  )
}

function BoardList({ shown }) {
  const { t, me, isManager } = useApp()
  const [picked, setPicked] = useState([])
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])
  const visiblePicked = picked.filter((id) => shown.some((x) => x.id === id))
  if (shown.length === 0) return <p className="muted">{t('noTasks')}</p>
  return (
    <>
      {visiblePicked.length > 0 && <BulkBar ids={visiblePicked} clear={() => setPicked([])} />}
      <div className="sheet">
        {shown.map((x) => (
          <TaskRow key={x.id} task={x} selectable={isManager && canManage(x, me)} selected={picked.includes(x.id)} onSelect={toggle} />
        ))}
      </div>
    </>
  )
}

export function Board() {
  const { t, lang, tasks, departments } = useApp()
  const [q, setQ] = useState('')
  const [dept, setDept] = useState('')
  const [lateOnly, setLateOnly] = useState(false)
  const [mode, setMode] = useState('columns')
  const shown = tasks.filter((x) =>
    (!dept || x.department_id === dept) && (!lateOnly || isLate(x)) && (!q || x.title.toLowerCase().includes(q.toLowerCase())))

  return (
    <div className="page board-page">
      <QuickAdd />
      <div className="filters">
        <div className="search"><Icon name="search" /><input placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label={t('department')}>
          <option value="">{t('departments')}: {t('all')}</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{lang === 'ar' ? d.name_ar : d.name_en}</option>)}
        </select>
        <label className="toggle"><input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} />{t('lateOnly')}</label>
        <div className="segmented compact">
          <button type="button" className={mode === 'columns' ? 'on' : ''} onClick={() => setMode('columns')}>{t('columns')}</button>
          <button type="button" className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>{t('listView')}</button>
        </div>
      </div>
      {mode === 'columns' ? <BoardColumns shown={shown} /> : <BoardList shown={shown} />}
    </div>
  )
}

export function Palette({ views, onView, onClose }) {
  const { t, tasks, people, projects, openTask } = useApp()
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  useEscape(onClose)

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    const pages = views
      .filter(([, label]) => !term || label.toLowerCase().includes(term))
      .map(([id, label, icon]) => ({ key: `v-${id}`, label, sub: t('goTo'), icon, run: () => onView(id) }))
    const found = !term ? [] : tasks.filter((x) => {
      const names = x.task_assignees.map((a) => people.find((p) => p.id === a.user_id)?.full_name || '').join(' ')
      const project = projects.find((p) => p.id === x.project_id)
      return `${x.title} ${x.description || ''} ${names} ${project?.name || ''} ${project?.code || ''}`.toLowerCase().includes(term)
    }).slice(0, 12).map((x) => ({ key: x.id, label: x.title, sub: t(x.status), icon: 'list', run: () => openTask(x.id) }))
    return [...found, ...pages]
  }, [q, tasks, people, projects, views, t, onView, openTask])

  function choose(item) {
    if (!item) return
    item.run()
    onClose()
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(Math.min(index + 1, results.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(Math.max(index - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); choose(results[index]) }
  }

  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('searchAll')}>
        <div className="palette-input">
          <Icon name="search" />
          <input autoFocus placeholder={t('paletteHint')} aria-label={t('paletteHint')} value={q} onChange={(e) => { setQ(e.target.value); setIndex(0) }} onKeyDown={onKey} />
        </div>
        <div className="palette-list">
          {results.length === 0 && <p className="muted pad">{t('noResults')}</p>}
          {results.map((item, i) => (
            <button key={item.key} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => choose(item)}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <small>{item.sub}</small>
            </button>
          ))}
        </div>
        <p className="palette-foot">{t('shortcuts')}</p>
      </div>
    </div>
  )
}

export function PrioritySelect({ value, onChange }) {
  const { t } = useApp()
  return (
    <div className="segmented" role="radiogroup" aria-label={t('priority')}>
      {['low', 'normal', 'high', 'urgent'].map((p) => (
        <button type="button" key={p} role="radio" aria-checked={value === p} className={value === p ? 'on' : ''} onClick={() => onChange(p)}>{t(p)}</button>
      ))}
    </div>
  )
}

export function ChecklistEditor({ items, setItems }) {
  const { t } = useApp()
  const update = (i, patch) => setItems(items.map((it, n) => (n === i ? { ...it, ...patch } : it)))
  return (
    <div className="stack tight">
      {items.map((it, i) => (
        <div className="check-edit" key={i}>
          <input placeholder={t('itemText')} aria-label={t('itemText')} value={it.text} onChange={(e) => update(i, { text: e.target.value })} />
          <div className="check-edit-opts">
            <label className="check"><input type="checkbox" checked={it.required} onChange={(e) => update(i, { required: e.target.checked })} />{t('required')}</label>
            <label className="check"><input type="checkbox" checked={it.needs_proof} onChange={(e) => update(i, { needs_proof: e.target.checked })} />{t('needsProof')}</label>
            <button type="button" className="icon-btn small" onClick={() => setItems(items.filter((_, n) => n !== i))} aria-label={t('remove')}><Icon name="close" size={15} /></button>
          </div>
        </div>
      ))}
      <button type="button" className="btn ghost start" onClick={() => setItems([...items, { text: '', required: true, needs_proof: false }])}><Icon name="plus" size={16} />{t('addItem')}</button>
    </div>
  )
}

export function AssigneePicker({ selected, setSelected, separate, setSeparate, department }) {
  const { t, people, deptName } = useApp()
  const [q, setQ] = useState('')
  const active = people.filter((p) => p.active && (!q || p.full_name.includes(q) || p.username.includes(q.toLowerCase())))
    .sort((a, b) => (b.department_id === department) - (a.department_id === department))
  const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  return (
    <div className="stack tight">
      <div className="search"><Icon name="search" /><input placeholder={t('searchPeople')} aria-label={t('searchPeople')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="people-pick">
        {active.map((p) => (
          <button type="button" key={p.id} aria-pressed={selected.includes(p.id)} className={selected.includes(p.id) ? 'on' : ''} onClick={() => toggle(p.id)}>
            <Avatar id={p.id} small />
            <span>{p.full_name}<small>{deptName(p.department_id)}</small></span>
            {selected.includes(p.id) && <Icon name="check" size={17} />}
          </button>
        ))}
        {active.length === 0 && <p className="muted pad">{t('noResults')}</p>}
      </div>
      {selected.length > 1 && (
        <div className="choice">
          <label className={separate ? 'on' : ''}><input type="radio" checked={separate} onChange={() => setSeparate(true)} /><span><b>{t('separate')}</b><small>{t('separateHint')}</small></span></label>
          <label className={!separate ? 'on' : ''}><input type="radio" checked={!separate} onChange={() => setSeparate(false)} /><span><b>{t('shared')}</b><small>{t('sharedHint')}</small></span></label>
        </div>
      )}
    </div>
  )
}

export function DueDatePicker({ value, onChange }) {
  const { t } = useApp()
  const quick = [[t('today'), today()], [t('tomorrow'), dateAfter(1)], [t('inWeek'), dateAfter(7)], [t('noDate'), '']]
  return (
    <div className="date-pick">
      <div className="segmented">
        {quick.map(([label, date]) => (
          <button type="button" key={label} className={value === date ? 'on' : ''} onClick={() => onChange(date)}>{label}</button>
        ))}
      </div>
      <input type="date" aria-label={t('dueDate')} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export function TaskForm({ onClose }) {
  const { t, me, lang, isManager, departments, projects, people: staff, personName, toast, loadTasks } = useApp()
  const [toTell, setToTell] = useState(null)
  const isAdmin = me.role === 'admin'
  const [form, setForm] = useState({ title: '', description: '', priority: 'normal', due_date: '', department_id: me.department_id || '', project_id: '', drawing_link: '' })
  const [items, setItems] = useState([])
  const [assignees, setAssignees] = useState([])
  const [separate, setSeparate] = useState(true)
  const [approval, setApproval] = useState(true)
  const [files, setFiles] = useState([])
  const [presets, setPresets] = useState([])
  const [preset, setPreset] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  useEffect(() => {
    if (isManager) supabase.from('presets').select('*').order('title').then(({ data }) => setPresets(data || []))
  }, [isManager])

  function applyPreset(id) {
    const p = presets.find((x) => x.id === id) || null
    setPreset(p)
    if (!p) return
    setForm({
      ...form, title: p.title, description: p.description || '', priority: p.priority,
      department_id: isAdmin ? p.department_id || form.department_id : form.department_id,
      due_date: p.due_in_days != null ? dateAfter(p.due_in_days) : '',
    })
    setItems(p.checklist)
  }

  async function submit(e) {
    e.preventDefault()
    const people = isManager ? assignees : [me.id]
    if (people.length === 0) return toast(t('pickAssignee'), true)
    setBusy(true)
    try {
      const uploaded = [...(preset?.attachments || [])]
      for (const file of files) uploaded.push({ file_path: await uploadFile('attachments', file), file_name: file.name })
      const created = await createTasks({
        fields: {
          title: form.title.trim(),
          description: form.description || null,
          priority: form.priority,
          due_date: form.due_date || null,
          department_id: form.department_id || null,
          project_id: form.project_id || null,
          drawing_link: form.drawing_link || null,
          preset_id: preset?.id || null,
          needs_approval: isManager && approval,
        },
        assignees: people,
        separate,
        checklist: items.filter((i) => i.text.trim()),
        files: uploaded,
      })
      await loadTasks()
      toast(t('created'))
      const tell = created.flatMap((task) => task.assignees
        .filter((id) => id !== me.id && staff.find((p) => p.id === id)?.phone)
        .map((id) => ({ task, id })))
      if (tell.length) setToTell(tell)
      else onClose()
    } catch (err) {
      toast(err.message || t('error'), true)
    }
    setBusy(false)
  }

  if (toTell) {
    return (
      <Modal title={t('tellOnWhatsapp')} onClose={onClose}>
        <div className="stack">
          <p className="muted">{t('tellHint')}</p>
          {toTell.map(({ task, id }) => (
            <div className="tell-row" key={`${task.id}-${id}`}>
              <span className="person-cell"><Avatar id={id} small />{personName(id)}</span>
              <WhatsAppLink personId={id} task={task} kind="assigned" labelled />
            </div>
          ))}
          <button className="btn primary" onClick={onClose}>{t('done_btn')}</button>
        </div>
      </Modal>
    )
  }

  const count = isManager && separate ? assignees.length : 1
  return (
    <Drawer
      title={t('newTask')}
      onClose={onClose}
      footer={<>
        <button className="btn ghost" type="button" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary big" form="task-form" disabled={busy}>{count > 1 ? fill(t('createTasks'), { n: count }) : t('createTask')}</button>
      </>}
    >
      <form id="task-form" className="form-sections" onSubmit={submit}>
        {presets.length > 0 && (
          <label className="preset-pick">{t('startFrom')}
            <select value={preset?.id || ''} onChange={(e) => applyPreset(e.target.value)}>
              <option value="">{t('blank')}</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
        )}
        <section>
          <h3>{t('whatTitle')}</h3>
          <input className="title-input" required autoFocus placeholder={t('title')} aria-label={t('title')} value={form.title} onChange={set('title')} />
          <textarea rows="3" placeholder={`${t('description')} (${t('optional')})`} aria-label={t('description')} value={form.description} onChange={set('description')} />
        </section>
        {isManager ? (
          <section>
            <h3>{t('whoTitle')}</h3>
            {isAdmin && (
              <label>{t('department')}
                <select value={form.department_id} onChange={set('department_id')}>
                  <option value="">{t('none')}</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{lang === 'ar' ? d.name_ar : d.name_en}</option>)}
                </select>
              </label>
            )}
            <AssigneePicker selected={assignees} setSelected={setAssignees} separate={separate} setSeparate={setSeparate} department={form.department_id} />
            <label className="switch-line">
              <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
              <span><b>{t('needsApproval')}</b><small>{t('needsApprovalHint')}</small></span>
            </label>
          </section>
        ) : <p className="note-line">{t('forYourself')}</p>}
        <section>
          <h3>{t('whenTitle')}</h3>
          <DueDatePicker value={form.due_date} onChange={(due_date) => setForm({ ...form, due_date })} />
          <div>
            <span className="field-label">{t('priority')}</span>
            <PrioritySelect value={form.priority} onChange={(priority) => setForm({ ...form, priority })} />
          </div>
        </section>
        <section>
          <h3>{t('checklist')} <small className="muted">({t('optional')})</small></h3>
          <ChecklistEditor items={items} setItems={setItems} />
        </section>
        <details className="more">
          <summary><Icon name="chevron" size={16} />{t('more')}</summary>
          <div className="stack">
            <label>{t('project')}
              <select value={form.project_id} onChange={set('project_id')}>
                <option value="">{t('none')}</option>
                {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>{t('drawingLink')}<input dir="ltr" type="url" placeholder="https://" value={form.drawing_link} onChange={set('drawing_link')} /></label>
            <label>{t('addFiles')}<input type="file" multiple onChange={(e) => setFiles([...e.target.files])} /></label>
          </div>
        </details>
      </form>
    </Drawer>
  )
}

const steps = ['todo', 'in_progress', 'review', 'done']

function Stepper({ task }) {
  const { t } = useApp()
  const { status } = task
  const shown = task.needs_approval ? steps : steps.filter((s) => s !== 'review')
  const current = status === 'returned' ? 1 : shown.indexOf(status)
  return (
    <ol className="stepper">
      {shown.map((s, i) => (
        <li key={s} className={`${i < current || status === 'done' ? 'past' : ''} ${i === current ? 'now' : ''} ${i === current && status === 'returned' ? 'red' : ''}`}>
          <i>{(i < current || status === 'done') && <Icon name="check" size={13} />}</i>
          <span>{i === current && status === 'returned' ? t('returned') : t(s)}</span>
        </li>
      ))}
    </ol>
  )
}

function History({ id, version }) {
  const { t, lang, personName } = useApp()
  const [rows, setRows] = useState([])
  useEffect(() => {
    supabase.from('task_history').select('*').eq('task_id', id).order('created_at', { ascending: false }).then(({ data }) => setRows(data || []))
  }, [id, version])

  const detail = (r) => {
    if (r.action === 'status' || r.action === 'priority') return t(r.detail)
    if (r.action === 'due') return r.detail ? formatDate(r.detail, lang) : t('noDate')
    if (r.action === 'assigned' || r.action === 'unassigned') return personName(r.detail)
    return r.detail || ''
  }

  if (rows.length === 0) return null
  return (
    <details className="more history">
      <summary><Icon name="chevron" size={16} />{t('history')}</summary>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <span><b>{personName(r.actor_id)}</b> {t(`h_${r.action}`)} {detail(r)}</span>
            <small className="muted">{new Date(r.created_at).toLocaleString(lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function TaskDetail({ id, onClose }) {
  const { t, me, lang, tasks, projects, personName, deptName, toast, loadTasks, moveTask } = useApp()
  const task = tasks.find((x) => x.id === id)
  const [items, setItems] = useState([])
  const [comments, setComments] = useState([])
  const [files, setFiles] = useState([])
  const [body, setBody] = useState('')
  const [returning, setReturning] = useState(false)
  const [marking, setMarking] = useState(null)
  const closeMarkup = useCallback(() => setMarking(null), [])

  const load = useCallback(async () => {
    const [c, m, f] = await Promise.all([
      supabase.from('checklist_items').select('*').eq('task_id', id).order('position'),
      supabase.from('comments').select('*').eq('task_id', id).order('created_at'),
      supabase.from('attachments').select('*').eq('task_id', id).order('created_at'),
    ])
    setItems(c.data || [])
    setComments(m.data || [])
    setFiles(f.data || [])
  }, [id])

  useEffect(() => {
    load()
    const channel = supabase.channel(`task-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments', filter: `task_id=eq.${id}` }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [id, load])

  const lastComment = useMemo(() => comments[comments.length - 1], [comments])
  if (!task) return null

  const manage = canManage(task, me)
  const work = canWork(task, me)
  const project = projects.find((p) => p.id === task.project_id)
  const ready = isReady(items)
  const action = nextAction(task, me)
  const fileError = (e) => toast(e.message, true)

  async function tick(item, done) {
    setItems(items.map((i) => (i.id === item.id ? { ...i, done } : i)))
    const { error } = await supabase.from('checklist_items').update({ done }).eq('id', item.id)
    if (error) toast(error.message, true)
    load()
    loadTasks()
  }

  async function proof(item, file) {
    try {
      const proof_path = await uploadFile(`proofs/${id}`, file)
      const { error } = await supabase.from('checklist_items').update({ proof_path, done: true }).eq('id', item.id)
      if (error) throw error
      load()
      loadTasks()
    } catch (err) {
      fileError(err)
    }
  }

  async function attach(fileList) {
    try {
      for (const file of fileList) {
        const file_path = await uploadFile('attachments', file)
        const { error } = await supabase.from('attachments').insert({ task_id: id, file_path, file_name: file.name })
        if (error) throw error
      }
      load()
    } catch (err) {
      fileError(err)
    }
  }

  async function saveMarkup(file) {
    const file_path = await uploadFile('attachments', file, { keepSize: true })
    const base = marking.name.replace(/\.[^.]+$/, '')
    const { error } = await supabase.from('attachments').insert({ task_id: id, file_path, file_name: `${t('markupPrefix')} - ${base}.jpg` })
    if (error) throw error
    await load()
    toast(t('markupSaved'))
    setMarking(null)
  }

  async function comment(e) {
    e.preventDefault()
    if (!body.trim()) return
    const { error } = await supabase.from('comments').insert({ task_id: id, body: body.trim(), author_id: me.id })
    if (error) return toast(error.message, true)
    if (returning) {
      await moveTask(task, 'returned')
      setReturning(false)
    }
    setBody('')
    load()
  }

  async function remove() {
    const { error } = await supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return toast(error.message, true)
    await loadTasks()
    toast(t('movedToTrash'))
    onClose()
  }

  let footer = null
  if (!work) footer = <p className="foot-note">{t('readOnly')}</p>
  else if (returning) {
    footer = <>
      <button className="btn ghost" onClick={() => { setReturning(false); setBody('') }}>{t('cancel')}</button>
      <button className="btn red big" form="comment-form">{t('returnTask')}</button>
    </>
  } else if (task.status === 'review' && manage) {
    footer = <>
      <button className="btn ghost" onClick={() => setReturning(true)}>{t('returnTask')}</button>
      <button className="btn primary big" onClick={() => moveTask(task, 'done')}><Icon name="check" />{t('approve')}</button>
    </>
  } else if (action) {
    const blocked = action.status !== 'in_progress' && !ready
    footer = <>
      {blocked && <p className="foot-note">{t('finishChecklist')}</p>}
      <button className="btn primary big" disabled={blocked} onClick={() => moveTask(task, action.status)}>{t(action.label)}</button>
    </>
  } else if (task.status === 'review') {
    footer = <p className="foot-note">{t('waitingReview')}</p>
  } else if (task.status === 'done') {
    footer = <>
      <p className="foot-note">{task.needs_approval ? t('approvedOn') : t('done')}</p>
      {manage && <button className="btn ghost" onClick={() => moveTask(task, 'in_progress')}>{t('reopen')}</button>}
    </>
  }

  return (
    <Drawer
      title={t('details')}
      onClose={onClose}
      footer={footer}
      tools={manage && <button className="icon-btn" onClick={remove} aria-label={t('deleteTask')} title={t('deleteTask')}><Icon name="trash" /></button>}
    >
      <div className="sheet-head">
        <h2 className="task-heading">{task.title}</h2>
        {task.status === 'done' && task.needs_approval && <span className="stamp">{t('stampDone')}</span>}
        {task.status === 'returned' && <span className="stamp red">{t('stampReturned')}</span>}
      </div>
      <Stepper task={task} />

      {task.status === 'returned' && lastComment && (
        <div className="redline"><strong>{t('returnedBecause')}</strong><p>{lastComment.body}</p></div>
      )}

      <dl className="block">
        <div className={isLate(task) ? 'late' : ''}><dt>{t('dueDate')}</dt><dd>{dueLabel(task, t, lang) || t('noDate')}</dd></div>
        <div><dt>{t('priority')}</dt><dd><span className={`pri p-${task.priority}`} />{t(task.priority)}</dd></div>
        <div><dt>{t('department')}</dt><dd>{deptName(task.department_id) || t('none')}</dd></div>
        <div><dt>{t('project')}</dt><dd>{project?.name || t('none')}</dd></div>
      </dl>

      <div className="assignee-line">
        <span className="field-label">{t('assignees')}</span>
        <div className="assignee-chips">
          {task.task_assignees.map((a) => (
            <span key={a.user_id}>
              <Avatar id={a.user_id} small />{personName(a.user_id)}
              {work && a.user_id !== me.id && <WhatsAppLink personId={a.user_id} task={task} kind={isLate(task) ? 'late' : 'task'} />}
            </span>
          ))}
        </div>
        {work && task.created_by && task.created_by !== me.id && !task.task_assignees.some((a) => a.user_id === task.created_by) && (
          <p className="created-by">
            {t('createdBy')}: {personName(task.created_by)}
            <WhatsAppLink personId={task.created_by} task={task} />
          </p>
        )}
      </div>

      {task.description && <p className="desc">{task.description}</p>}
      {task.drawing_link && /^https?:\/\//.test(task.drawing_link) && (
        <a className="file-link" href={task.drawing_link} target="_blank" rel="noopener noreferrer"><Icon name="link" size={16} />{t('drawingLink')}</a>
      )}

      {items.length > 0 && (
        <section className="detail-section">
          <h3>{t('checklist')}</h3>
          <div className="checks">
            {items.map((item) => (
              <div className="check-item" key={item.id}>
                <label className="check">
                  <input type="checkbox" checked={item.done} disabled={!work || (item.needs_proof && !item.proof_path)} onChange={(e) => tick(item, e.target.checked)} />
                  <span className={item.done ? 'struck' : ''}>{item.text}</span>
                </label>
                {!item.required && <small className="muted">{t('optional')}</small>}
                {item.proof_path && <button className="link" onClick={() => openFile(item.proof_path).catch(fileError)}>{t('viewProof')}</button>}
                {item.needs_proof && !item.proof_path && work && (
                  <label className="btn small"><Icon name="camera" size={15} />{t('uploadProof')}<input className="sr" type="file" onChange={(e) => e.target.files[0] && proof(item, e.target.files[0])} /></label>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {work && (
        <section className="detail-section">
          <h3>{t('files')}</h3>
          {files.map((f) => (
            <div className="file-row" key={f.id}>
              <button className="file-link" onClick={() => openFile(f.file_path).catch(fileError)}><Icon name="clip" size={16} />{f.file_name}</button>
              {canMarkUp(f.file_name) && (
                <button
                  className="btn small"
                  onClick={() => setMarking({ name: f.file_name, source: () => downloadFile(f.file_path) })}
                ><Icon name="pen" size={15} />{t('markUp')}</button>
              )}
            </div>
          ))}
          <div className="row">
            <label className="btn small"><Icon name="plus" size={15} />{t('addFiles')}<input className="sr" type="file" multiple onChange={(e) => attach([...e.target.files])} /></label>
            <label className="btn small"><Icon name="pen" size={15} />{t('markUpNew')}<input
              className="sr"
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => {
                const file = e.target.files[0]
                e.target.value = ''
                if (file) setMarking({ name: file.name, source: file })
              }}
            /></label>
          </div>
        </section>
      )}
      {marking && <MarkupEditor source={marking.source} name={marking.name} onSave={saveMarkup} onClose={closeMarkup} />}

      {work && (
        <section className="detail-section">
          <h3>{t('comments')}</h3>
          {comments.map((c) => (
            <div className="comment" key={c.id}>
              <Avatar id={c.author_id} small />
              <div>
                <strong>{personName(c.author_id)}</strong>
                <small className="muted">{new Date(c.created_at).toLocaleString(lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
                <p>{c.body}</p>
              </div>
            </div>
          ))}
          <form id="comment-form" className="comment-form" onSubmit={comment}>
            <textarea rows="2" autoFocus={returning} required={returning} placeholder={returning ? t('returnReason') : t('addComment')} aria-label={t('addComment')} value={body} onChange={(e) => setBody(e.target.value)} />
            {!returning && <button className="btn">{t('send')}</button>}
          </form>
        </section>
      )}

      {work && <History id={id} version={`${task.status}-${task.due_date}-${task.priority}`} />}
    </Drawer>
  )
}
