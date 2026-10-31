import React, { useMemo, useState } from 'react'
import { canManage, dateAfter, fill, formatDate, isAssigned, isLate, supabase, today, useApp } from './lib.js'
import { Avatar } from './tasks.jsx'
import { Icon } from './icons.jsx'

// The Excel library is large, so it only downloads when someone exports.
export async function saveWorkbook(sheets, fileName, lang) {
  const { default: writeXlsxFile } = await import('write-excel-file')
  await writeXlsxFile(sheets.map((s) => s.rows), {
    schema: sheets.map((s) => s.columns.map(([column, value, type]) => ({
      column, value, type: type || String, width: type === Number ? 12 : 28,
    }))),
    sheets: sheets.map((s) => s.name.slice(0, 31)),
    fileName,
    rightToLeft: lang === 'ar',
  })
}

// The API returns at most 1000 rows per request, so backups read page by page.
async function readAll(table, orderBy) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select('*').order(orderBy).range(from, from + 999)
    if (error) throw error
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

const cellText = (value) => {
  if (value === null || value === undefined) return ''
  return (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 32000)
}

const backupTables = [
  ['departments', 'id'], ['profiles', 'id'], ['invites', 'username'], ['projects', 'id'], ['tasks', 'id'],
  ['task_assignees', 'task_id'], ['checklist_items', 'id'], ['comments', 'id'], ['attachments', 'id'],
  ['presets', 'id'], ['recurrences', 'id'], ['task_history', 'id'],
]

async function downloadBackup(lang) {
  const sheets = []
  for (const [table, orderBy] of backupTables) {
    const rows = await readAll(table, orderBy)
    const keys = rows.length ? Object.keys(rows[0]) : ['empty']
    sheets.push({ name: table, rows, columns: keys.map((k) => [k, (r) => cellText(r[k])]) })
  }
  await saveWorkbook(sheets, `CVI-backup-${today()}.xlsx`, lang)
}

// Weeks run Saturday to Thursday, with Friday off. offset 0 is this week.
function weekRange(offset) {
  const now = new Date(`${today()}T00:00:00`)
  const sinceSaturday = (now.getDay() + 1) % 7
  const start = new Date(now)
  start.setDate(now.getDate() - sinceSaturday + offset * 7)
  const end = new Date(start)
  end.setDate(start.getDate() + 7)
  return { start, end }
}

const inRange = (value, { start, end }) => {
  if (!value) return false
  const when = new Date(value)
  return when >= start && when < end
}

function countsFor(tasks, range) {
  const open = tasks.filter((x) => x.status !== 'done')
  return {
    created: tasks.filter((x) => inRange(x.created_at, range)).length,
    finished: tasks.filter((x) => x.status === 'done' && inRange(x.completed_at, range)).length,
    open: open.length,
    late: open.filter(isLate).length,
    review: open.filter((x) => x.status === 'review').length,
  }
}

function WeekPicker({ offset, setOffset, range }) {
  const { t, lang } = useApp()
  const last = new Date(range.end)
  last.setDate(last.getDate() - 2)
  const iso = (d) => d.toLocaleDateString('en-CA')
  return (
    <div className="week-picker">
      <button className="btn small" onClick={() => setOffset(offset - 1)}>{t('prevWeek')}</button>
      <strong>{offset === 0 ? t('thisWeek') : `${formatDate(iso(range.start), lang)} – ${formatDate(iso(last), lang)}`}</strong>
      <button className="btn small" disabled={offset === 0} onClick={() => setOffset(offset + 1)}>{t('nextWeek')}</button>
    </div>
  )
}

function MyNumbers() {
  const { t, me, tasks } = useApp()
  const [offset, setOffset] = useState(0)
  const range = weekRange(offset)
  const c = countsFor(tasks.filter((x) => isAssigned(x, me)), range)
  return (
    <div className="page">
      <WeekPicker offset={offset} setOffset={setOffset} range={range} />
      <dl className="numbers">
        <div><dt>{t('finishedWeek')}</dt><dd>{c.finished}</dd></div>
        <div><dt>{t('openNow')}</dt><dd>{c.open}</dd></div>
        <div className={c.late ? 'late' : ''}><dt>{t('lateNow')}</dt><dd>{c.late}</dd></div>
        <div><dt>{t('inReview')}</dt><dd>{c.review}</dd></div>
      </dl>
    </div>
  )
}

export function Reports() {
  const { t, lang, me, isManager, tasks, departments, projects, people, deptName, toast } = useApp()
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const range = weekRange(offset)

  const scoped = useMemo(
    () => (isManager ? tasks.filter((x) => me.role === 'admin' || canManage(x, me)) : []),
    [tasks, me, isManager],
  )

  const deptRows = departments
    .filter((d) => me.role === 'admin' || d.id === me.department_id)
    .map((d) => ({ id: d.id, name: deptName(d.id), ...countsFor(scoped.filter((x) => x.department_id === d.id), range) }))

  const projectRows = projects.filter((p) => !p.archived).map((p) => {
    const list = scoped.filter((x) => x.project_id === p.id)
    const done = list.filter((x) => x.status === 'done').length
    return { ...p, total: list.length, done, late: list.filter(isLate).length, share: list.length ? done / list.length : 0 }
  }).filter((p) => p.total > 0)

  const peopleRows = people
    .filter((p) => p.active && (me.role === 'admin' || p.department_id === me.department_id))
    .map((p) => ({ id: p.id, name: p.full_name, dept: deptName(p.department_id), ...countsFor(scoped.filter((x) => isAssigned(x, p)), range) }))
    .filter((p) => p.created || p.finished || p.open)

  if (!isManager) return <MyNumbers />

  const number = (key) => [(r) => r[key], Number]
  async function exportReport() {
    setBusy(true)
    try {
      await saveWorkbook([
        {
          name: t('departments'), rows: deptRows,
          columns: [[t('department'), (r) => r.name], [t('finishedWeek'), ...number('finished')], [t('createdWeek'), ...number('created')], [t('openNow'), ...number('open')], [t('lateNow'), ...number('late')], [t('inReview'), ...number('review')]],
        },
        {
          name: t('projects'), rows: projectRows,
          columns: [[t('project'), (r) => r.name], [t('code'), (r) => r.code || ''], [t('deadline'), (r) => r.deadline || ''], [t('tasksTotal'), ...number('total')], [t('g_done'), ...number('done')], [t('lateNow'), ...number('late')]],
        },
        {
          name: t('people'), rows: peopleRows,
          columns: [[t('person'), (r) => r.name], [t('department'), (r) => r.dept], [t('finishedWeek'), ...number('finished')], [t('openNow'), ...number('open')], [t('lateNow'), ...number('late')]],
        },
        {
          name: t('tasksSheet'), rows: scoped,
          columns: [
            [t('title'), (x) => x.title], [t('status'), (x) => t(x.status)], [t('priority'), (x) => t(x.priority)],
            [t('dueDate'), (x) => x.due_date || ''], [t('department'), (x) => deptName(x.department_id)],
            [t('project'), (x) => projects.find((p) => p.id === x.project_id)?.name || ''],
            [t('assignees'), (x) => x.task_assignees.map((a) => people.find((p) => p.id === a.user_id)?.full_name || '').join('، ')],
          ],
        },
      ], `CVI-report-${today()}.xlsx`, lang)
    } catch (err) {
      toast(err.message, true)
    }
    setBusy(false)
  }

  async function backup() {
    setBusy(true)
    try {
      await downloadBackup(lang)
      toast(t('backupDone'))
    } catch (err) {
      toast(err.message, true)
    }
    setBusy(false)
  }

  const hasData = scoped.length > 0
  return (
    <div className="page">
      <div className="report-head">
        <WeekPicker offset={offset} setOffset={setOffset} range={range} />
        <button className="btn primary" disabled={busy || !hasData} onClick={exportReport}><Icon name="download" />{t('exportExcel')}</button>
      </div>

      {!hasData && <div className="empty"><Icon name="overview" size={28} /><strong>{t('noReportData')}</strong><span>{t('noReportHint')}</span></div>}

      {hasData && (
        <>
          <section className="group">
            <h3>{t('departments')}</h3>
            <div className="sheet table-wrap">
              <table className="report-table">
                <thead><tr><th>{t('department')}</th><th>{t('finishedWeek')}</th><th>{t('createdWeek')}</th><th>{t('openNow')}</th><th>{t('lateNow')}</th><th>{t('inReview')}</th></tr></thead>
                <tbody>
                  {deptRows.map((r) => (
                    <tr key={r.id}><td>{r.name}</td><td>{r.finished}</td><td>{r.created}</td><td>{r.open}</td><td className={r.late ? 'late' : ''}>{r.late}</td><td>{r.review}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {projectRows.length > 0 && (
            <section className="group">
              <h3>{t('projectProgress')}</h3>
              <div className="sheet pad-sheet">
                {projectRows.map((p) => (
                  <div key={p.id}>
                    <div className="load-text">
                      <span>{p.name}{p.late > 0 && <small className="late"> ({p.late} {t('late')})</small>}</span>
                      <b dir="ltr">{p.done}/{p.total}</b>
                    </div>
                    <div className="bar"><i style={{ width: `${p.share * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {peopleRows.length > 0 && (
            <section className="group">
              <h3>{t('people')}</h3>
              <div className="sheet table-wrap">
                <table className="report-table">
                  <thead><tr><th>{t('person')}</th><th>{t('finishedWeek')}</th><th>{t('openNow')}</th><th>{t('lateNow')}</th></tr></thead>
                  <tbody>
                    {peopleRows.map((r) => (
                      <tr key={r.id}><td><span className="person-cell"><Avatar id={r.id} small />{r.name}</span></td><td>{r.finished}</td><td>{r.open}</td><td className={r.late ? 'late' : ''}>{r.late}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {me.role === 'admin' && (
        <section className="group">
          <h3>{t('backup')}</h3>
          <div className="sheet item-row">
            <p className="item-main">{t('backupHint')}</p>
            <button className="btn" disabled={busy} onClick={backup}><Icon name="download" />{t('backupNow')}</button>
          </div>
        </section>
      )}
    </div>
  )
}
