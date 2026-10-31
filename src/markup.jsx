import React, { useCallback, useEffect, useRef, useState } from 'react'
import { fill, useApp } from './lib.js'
import { Icon } from './icons.jsx'

const MAX_SIZE = 2400
const COLORS = ['#e0301e', '#000000']
const TOOLS = [['pen', 'toolPen'], ['arrow', 'toolArrow'], ['circle', 'toolCircle'], ['text', 'toolText']]

export const isPdf = (name) => /\.pdf$/i.test(name || '')
export const canMarkUp = (name) => isPdf(name) || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(name || '')

// The PDF reader is large, so it only downloads when someone opens a PDF.
async function openPdf(file) {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.min.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
}

async function renderPage(pdf, number) {
  const page = await pdf.getPage(number)
  const natural = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: MAX_SIZE / Math.max(natural.width, natural.height) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  return canvas
}

// Large photos are scaled down here so the editor stays quick on phones.
async function loadImage(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIZE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

function drawOp(ctx, op, unit) {
  ctx.strokeStyle = op.color
  ctx.fillStyle = op.color
  ctx.lineWidth = unit
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (op.tool === 'pen') {
    ctx.beginPath()
    op.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.stroke()
  } else if (op.tool === 'arrow') {
    const [[x1, y1], [x2, y2]] = op.points
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const head = unit * 5
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.moveTo(x2 - head * Math.cos(angle - 0.5), y2 - head * Math.sin(angle - 0.5))
    ctx.lineTo(x2, y2)
    ctx.lineTo(x2 - head * Math.cos(angle + 0.5), y2 - head * Math.sin(angle + 0.5))
    ctx.stroke()
  } else if (op.tool === 'circle') {
    const [[x1, y1], [x2, y2]] = op.points
    ctx.beginPath()
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (op.tool === 'text') {
    const [x, y] = op.points[0]
    const arabic = /[؀-ۿ]/.test(op.text)
    ctx.font = `600 ${unit * 7}px 'IBM Plex Sans Arabic', Tahoma, sans-serif`
    ctx.direction = arabic ? 'rtl' : 'ltr'
    ctx.textAlign = 'start'
    ctx.textBaseline = 'middle'
    // A white edge keeps the words readable on top of busy drawings.
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = unit * 1.6
    ctx.strokeText(op.text, x, y)
    ctx.fillText(op.text, x, y)
  }
}

function PdfPagePicker({ pdf, onPick, onClose }) {
  const { t, toast } = useApp()
  const [number, setNumber] = useState(1)
  const [busy, setBusy] = useState(true)
  const holder = useRef(null)
  const shown = useRef(null)

  useEffect(() => {
    let current = true
    setBusy(true)
    renderPage(pdf, number).then((canvas) => {
      if (!current) return
      shown.current = canvas
      holder.current?.replaceChildren(canvas)
      setBusy(false)
    }).catch((err) => toast(err.message, true))
    return () => { current = false }
  }, [pdf, number, toast])

  return (
    <div className="markup" role="dialog" aria-modal="true" aria-label={t('choosePage')}>
      <div className="markup-bar">
        <strong>{t('choosePage')}</strong>
        <div className="row">
          <button className="btn small" disabled={number <= 1} onClick={() => setNumber(number - 1)}>{t('prevPage')}</button>
          <span>{fill(t('pageOf'), { n: number, total: pdf.numPages })}</span>
          <button className="btn small" disabled={number >= pdf.numPages} onClick={() => setNumber(number + 1)}>{t('nextPage')}</button>
        </div>
      </div>
      <div className="markup-stage"><div className="markup-paper pdf-preview" ref={holder} /></div>
      <div className="markup-foot">
        <button className="btn ghost" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary big" disabled={busy} onClick={() => onPick(shown.current, number)}>{t('usePage')}</button>
      </div>
    </div>
  )
}

function Editor({ base, onSave, onClose }) {
  const { t, toast } = useApp()
  const canvas = useRef(null)
  const draft = useRef(null)
  const input = useRef(null)
  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState(COLORS[0])
  const [ops, setOps] = useState([])
  const [typing, setTyping] = useState(null)
  const [busy, setBusy] = useState(false)
  const unit = Math.max(base.width, base.height) / 300

  const redraw = useCallback(() => {
    const ctx = canvas.current.getContext('2d')
    ctx.drawImage(base, 0, 0)
    ops.forEach((op) => drawOp(ctx, op, unit))
    if (draft.current) drawOp(ctx, draft.current, unit)
  }, [base, ops, unit])

  useEffect(() => { redraw() }, [redraw])
  useEffect(() => { if (typing) input.current?.focus() }, [typing])

  const point = (e) => {
    const rect = canvas.current.getBoundingClientRect()
    return [
      ((e.clientX - rect.left) / rect.width) * canvas.current.width,
      ((e.clientY - rect.top) / rect.height) * canvas.current.height,
    ]
  }

  function down(e) {
    e.preventDefault()
    if (tool === 'text') {
      if (typing) return commitText()
      const rect = canvas.current.getBoundingClientRect()
      setTyping({ at: point(e), left: e.clientX - rect.left, top: e.clientY - rect.top, value: '' })
      return
    }
    try { canvas.current.setPointerCapture(e.pointerId) } catch {}
    const start = point(e)
    draft.current = { tool, color, points: tool === 'pen' ? [start] : [start, start] }
    redraw()
  }

  function move(e) {
    if (!draft.current) return
    const next = point(e)
    if (draft.current.tool === 'pen') draft.current.points.push(next)
    else draft.current.points[1] = next
    redraw()
  }

  function up() {
    const finished = draft.current
    draft.current = null
    if (!finished) return
    const [[x1, y1]] = finished.points
    const [x2, y2] = finished.points[finished.points.length - 1]
    // A plain tap would leave an invisible shape that only confuses Undo.
    if (finished.tool !== 'pen' && Math.hypot(x2 - x1, y2 - y1) < unit * 3) return redraw()
    setOps((list) => [...list, finished])
  }

  function commitText() {
    if (typing?.value.trim()) setOps((list) => [...list, { tool: 'text', color, points: [typing.at], text: typing.value.trim() }])
    setTyping(null)
  }

  async function save() {
    commitText()
    setBusy(true)
    // Waits one frame so text typed just before pressing Save is drawn first.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)))
    const blob = await new Promise((resolve) => canvas.current.toBlob(resolve, 'image/jpeg', 0.85))
    try {
      await onSave(new File([blob], 'markup.jpg', { type: 'image/jpeg' }))
    } catch (err) {
      toast(err.message, true)
      setBusy(false)
    }
  }

  return (
    <div className="markup" role="dialog" aria-modal="true" aria-label={t('markUp')}>
      <div className="markup-bar">
        <div className="segmented">
          {TOOLS.map(([id, label]) => (
            <button key={id} type="button" className={tool === id ? 'on' : ''} aria-pressed={tool === id} onClick={() => setTool(id)}>
              <Icon name={id} size={16} />{t(label)}
            </button>
          ))}
        </div>
        <div className="row">
          {COLORS.map((c) => (
            <button key={c} type="button" className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c === COLORS[0] ? t('colorRed') : t('colorBlack')} aria-pressed={color === c} onClick={() => setColor(c)} />
          ))}
          <button className="btn small" disabled={!ops.length} onClick={() => setOps(ops.slice(0, -1))}><Icon name="undo" size={15} />{t('undo')}</button>
          <button className="btn small" disabled={!ops.length} onClick={() => setOps([])}>{t('clearAll')}</button>
        </div>
      </div>
      <div className="markup-stage">
        <div className="markup-paper">
          <canvas
            ref={canvas}
            width={base.width}
            height={base.height}
            className={tool === 'text' ? 'typing' : ''}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
          {typing && (
            <input
              ref={input}
              className="markup-text"
              style={{ left: typing.left, top: typing.top, color }}
              placeholder={t('typeHere')}
              value={typing.value}
              onChange={(e) => setTyping({ ...typing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText()
                if (e.key === 'Escape') setTyping(null)
              }}
            />
          )}
        </div>
      </div>
      <div className="markup-foot">
        <button className="btn ghost" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary big" disabled={busy || !ops.length} onClick={save}>{t('saveMarkup')}</button>
      </div>
    </div>
  )
}

// source is a File, or a function that fetches one for files already on the task.
export function MarkupEditor({ source, name, onSave, onClose }) {
  const { t, toast } = useApp()
  const [pdf, setPdf] = useState(null)
  const [base, setBase] = useState(null)

  useEffect(() => {
    let current = true
    ;(async () => {
      const file = typeof source === 'function' ? await source() : source
      if (isPdf(name) || file.type === 'application/pdf') {
        const doc = await openPdf(file)
        if (!current) return
        if (doc.numPages === 1) setBase(await renderPage(doc, 1))
        else setPdf(doc)
      } else {
        const image = await loadImage(file)
        if (current) setBase(image)
      }
    })().catch(() => {
      if (!current) return
      toast(t('cantOpenFile'), true)
      onClose()
    })
    return () => { current = false }
  }, [source, name, t, toast, onClose])

  if (base) return <Editor base={base} onSave={onSave} onClose={onClose} />
  if (pdf) return <PdfPagePicker pdf={pdf} onPick={setBase} onClose={onClose} />
  return <div className="markup loading" role="status">{t('openingFile')}</div>
}
