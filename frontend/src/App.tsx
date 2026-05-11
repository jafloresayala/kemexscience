import { useState, useEffect, useRef, useCallback, useMemo, KeyboardEvent } from 'react'
import './index.css'

// ─── AI Pet ───────────────────────────────────────────────────────────────────
const PET_IDLE = [
  ['  ┌───┐  ', '  │◔ ◔│  ', '  │ — │  ', '  └───┘  ', '  /| |\ '],
  ['  ┌───┐  ', '  │◔ ◔│  ', '  │ — │  ', '  └───┘  ', '  /|_|\ '],
]
const PET_THINK = [
  ['  ┌───┐  ', '  │◕ ◕│  ', '  │ ⋯ │  ', '  └───┘  ', '  /| |\ '],
  ['  ┌───┐  ', '  │◕ ◕│  ', '  │⋯⋯⋯│  ', '  └───┘  ', '  /| |\ '],
  ['  ┌───┐  ', '  │◕ ◕│  ', '  │ ⋯ │  ', '  └───┘  ', ' _/| |\ '],
  ['  ┌───┐  ', '  │◕ ◕│  ', '  │⋯⋯⋯│  ', '  └───┘  ', '  /| |\_ '],
]
const PET_EXEC = [
  ['  ┌───┐  ', '  │◉ ◉│  ', '  │ ▼ │  ', '  └───┘  ', ' \| |/ '],
  ['  ┌───┐  ', '  │◉ ◉│  ', '  │▼▼▼│  ', '  └───┘  ', '  | |  '],
]

const THINK_BUBBLES = ['⋯', '⋯⋯', '⋯⋯⋯', '⋯⋯', '⋯']
const EXEC_SPARKS   = ['⚡', '⚡⚡', '⚡⚡⚡', '⚡⚡', '⚡']

function AIPet({ state, lightMode }: { state: AppState; lightMode: boolean }) {
  const [frame, setFrame] = useState(0)
  const [bubble, setBubble] = useState(0)

  useEffect(() => {
    const ms = state === 'thinking' ? 320 : state === 'executing' ? 200 : 600
    const iv = setInterval(() => {
      setFrame(f => f + 1)
      setBubble(b => (b + 1) % (state === 'executing' ? EXEC_SPARKS.length : THINK_BUBBLES.length))
    }, ms)
    return () => clearInterval(iv)
  }, [state])

  const thinking  = state === 'thinking'
  const executing = state === 'executing'
  const active    = thinking || executing

  const frames = thinking ? PET_THINK : executing ? PET_EXEC : PET_IDLE
  const art    = frames[frame % frames.length]
  const sparks = executing ? EXEC_SPARKS[bubble] : null
  const dots   = thinking  ? THINK_BUBBLES[bubble] : null

  const petColor  = thinking
    ? (lightMode ? '#b06000' : '#ffff00')
    : executing
    ? (lightMode ? '#005fa3' : '#00c8ff')
    : (lightMode ? '#99aabb55' : '#00ff4155')
  const textColor = thinking
    ? (lightMode ? '#b06000' : '#ffff00')
    : executing
    ? (lightMode ? '#005fa3' : '#00c8ff')
    : (lightMode ? '#8090b0' : '#3a5060')
  const idleBubbleColor = lightMode ? '#b0bcd0' : '#1a3020'
  const label     = thinking ? 'ANALIZANDO' : executing ? 'EJECUTANDO' : 'EN ESPERA'

  return (
    <div className="ai-pet" style={{ '--pet-color': petColor } as React.CSSProperties}>
      <div className="pet-art">
        {art.map((line, i) => (
          <div key={i} className="pet-line" style={{ color: petColor }}>{line}</div>
        ))}
      </div>
      <div className="pet-info">
        <div className="pet-label" style={{ color: textColor }}>{label}</div>
        {active && (
          <div className="pet-bubble" style={{ color: textColor }}>
            {dots ?? sparks}
          </div>
        )}
        {!active && <div className="pet-bubble" style={{ color: idleBubbleColor }}>z z z</div>}
      </div>
    </div>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────
type MsgRole = 'user' | 'agent' | 'system' | 'error'

interface Message {
  id: string
  role: MsgRole
  content: string
  timestamp: string
  plotUrl?: string
}

interface ToolEvent {
  id: string
  type: 'tool_call' | 'tool_result'
  name: string
  preview: string
  timestamp: string
}

type AppState = 'connecting' | 'ready' | 'error' | 'thinking' | 'executing'

interface ScanProgress {
  msg: string; pct?: number; file?: string; elapsed_s?: number
  scan_id?: string; from?: string; to?: string
}
interface ScanDone {
  lines: number; machines: number; tags: number; scan_id: string
}
type ScanPhase = 'idle' | 'running' | 'done' | 'error'
interface ScanState {
  phase: ScanPhase
  pct: number
  log: ScanProgress[]
  summary: ScanDone | null
  error: string | null
}

interface Status {
  state: AppState
  label: string
  error?: string
  model: string
  cacheInfo: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uid()  { return Math.random().toString(36).slice(2) }
function now()  { return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }

const CODE_RE = /```(?:python|py)\s*\n([\s\S]*?)```/gi

function extractLastCode(text: string): string | null {
  CODE_RE.lastIndex = 0
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = CODE_RE.exec(text)) !== null) last = m[1]
  return last
}

async function* readSSE(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { yield JSON.parse(line.slice(6)) } catch { /* skip */ }
      }
    }
  }
}

// ─── Code Block ───────────────────────────────────────────────────────────────
function CodeBlock({ code }: { code: string }) {
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-lang">● python</span>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}

// ─── Inline Markdown (bold, italic, inline-code) ──────────────────────────────
function renderInline(text: string): React.ReactNode[] {
  const INLINE_RE = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g
  const nodes: React.ReactNode[] = []
  let last = 0
  let im: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((im = INLINE_RE.exec(text)) !== null) {
    if (im.index > last) nodes.push(text.slice(last, im.index))
    if (im[2])      nodes.push(<strong key={im.index}><em>{im[2]}</em></strong>)
    else if (im[3]) nodes.push(<strong key={im.index}>{im[3]}</strong>)
    else if (im[4]) nodes.push(<em key={im.index}>{im[4]}</em>)
    else if (im[5]) nodes.push(<code key={im.index} className="inline-code">{im[5]}</code>)
    last = im.index + im[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// Render a block of plain text with markdown line rules (headings, bullets, blank lines)
function renderTextBlock(text: string, key: number): React.ReactNode {
  const lines = text.split('\n')
  const elems: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const h3 = line.match(/^###\s+(.+)/)
    const h2 = line.match(/^##\s+(.+)/)
    const h1 = line.match(/^#\s+(.+)/)
    const bullet = line.match(/^(\s*[-*•])\s+(.+)/)
    const numbered = line.match(/^\s*\d+\.\s+(.+)/)
    if (h3)       elems.push(<div key={i} className="md-h3">{renderInline(h3[1])}</div>)
    else if (h2)  elems.push(<div key={i} className="md-h2">{renderInline(h2[1])}</div>)
    else if (h1)  elems.push(<div key={i} className="md-h1">{renderInline(h1[1])}</div>)
    else if (bullet)  elems.push(<div key={i} className="md-li">{'• '}{renderInline(bullet[2])}</div>)
    else if (numbered) elems.push(<div key={i} className="md-li">{renderInline(line.trim())}</div>)
    else if (line.trim() === '') elems.push(<div key={i} className="md-gap" />)
    else elems.push(<div key={i} className="md-p">{renderInline(line)}</div>)
    i++
  }
  return <span key={key} className="msg-text">{elems}</span>
}

// ─── Message Body ─────────────────────────────────────────────────────────────
function MessageBody({ content }: { content: string }) {
  const parts: { type: 'text' | 'code'; content: string }[] = []
  let lastIdx = 0
  CODE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CODE_RE.exec(content)) !== null) {
    if (m.index > lastIdx) parts.push({ type: 'text', content: content.slice(lastIdx, m.index) })
    parts.push({ type: 'code', content: m[1] })
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < content.length) parts.push({ type: 'text', content: content.slice(lastIdx) })
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'text'
          ? renderTextBlock(p.content, i)
          : <CodeBlock key={i} code={p.content} />
      )}
    </>
  )
}

// ─── Message Bubble ───────────────────────────────────────────────────────────
function MessageBubble({
  msg,
  onExecute,
  onZoom,
}: {
  msg: Message
  onExecute?: (code: string) => void
  onZoom?: (url: string) => void
}) {
  const lastCode = msg.role === 'agent' ? extractLastCode(msg.content) : null

  return (
    <div className={`message message-${msg.role}`}>
      <div className="message-header">
        <span className="message-ts">[{msg.timestamp}]</span>
        <span className={`message-role role-${msg.role}`}>
          {msg.role === 'user'   ? 'TÚ  ▶'
           : msg.role === 'agent' ? 'AGENTE  ◀'
           : msg.role === 'error' ? '✖ ERROR'
           : '◈ SISTEMA'}
        </span>
      </div>
      <div className="message-body">
        <MessageBody content={msg.content} />
        {msg.plotUrl && (
          <div className="plot-container">
            <img
              src={msg.plotUrl}
              alt="Gráfica generada"
              className="plot-img"
              onClick={() => onZoom?.(msg.plotUrl!)}
              title="Click para ampliar"
            />
            <div className="plot-actions">
              <button className="plot-btn" onClick={() => onZoom?.(msg.plotUrl!)}>⤢ AMPLIAR</button>
            </div>
          </div>
        )}
      </div>
      {lastCode && onExecute && (
        <button className="exec-btn" onClick={() => onExecute(lastCode)}>
          ▶ Ejecutar código Python
        </button>
      )}
    </div>
  )
}

// ─── Health Scan Panel ─────────────────────────────────────────────────────────────
function HealthScanPanel({ scan, onClose }: { scan: ScanState; onClose: () => void }) {
  const logEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [scan.log])

  const phaseLabel: Record<ScanPhase, string> = {
    idle: 'LISTO', running: 'ESCANEANDO…', done: 'COMPLETADO', error: 'ERROR',
  }
  const phaseColor: Record<ScanPhase, string> = {
    idle: 'var(--dim)', running: 'var(--yellow)', done: 'var(--green)', error: 'var(--red)',
  }

  return (
    <div className="hscan-overlay" onClick={onClose}>
      <div className="hscan-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="hscan-hdr">
          <span className="hscan-logo" style={{ color: phaseColor[scan.phase] }}>⬡</span>
          <span className="hscan-title">PLANT HEALTH SCAN</span>
          <span className="hscan-phase" style={{ color: phaseColor[scan.phase] }}>
            {phaseLabel[scan.phase]}
          </span>
          <button className="hscan-close" onClick={onClose}>✕</button>
        </div>

        {/* Progress bar */}
        <div className="hscan-bar-bg">
          <div
            className={`hscan-bar-fill${scan.phase === 'running' ? ' hscan-bar-anim' : ''}`}
            style={{
              width: `${scan.pct}%`,
              background: scan.phase === 'done' ? 'var(--green)'
                : scan.phase === 'error' ? 'var(--red)'
                : 'var(--yellow)',
            }}
          />
        </div>
        <div className="hscan-pct">{scan.pct.toFixed(0)}%</div>

        {/* Summary */}
        {scan.summary && (
          <div className="hscan-summary">
            <div className="hscan-sum-row">
              <span className="hscan-sum-label">▣ LINEAS</span>
              <span className="hscan-sum-val">{scan.summary.lines}</span>
            </div>
            <div className="hscan-sum-row">
              <span className="hscan-sum-label">▣ MÁQUINAS</span>
              <span className="hscan-sum-val">{scan.summary.machines}</span>
            </div>
            <div className="hscan-sum-row">
              <span className="hscan-sum-label">▣ TAGS</span>
              <span className="hscan-sum-val">{scan.summary.tags}</span>
            </div>
          </div>
        )}

        {/* Error */}
        {scan.error && (
          <div className="hscan-error">{scan.error}</div>
        )}

        {/* Log */}
        <div className="hscan-log">
          {scan.log.map((l, i) => (
            <div key={i} className="hscan-log-row">
              {l.pct !== undefined && (
                <span className="hscan-log-pct">[{l.pct.toFixed(0)}%]</span>
              )}
              <span className="hscan-log-msg">{l.msg}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>

        {scan.phase === 'done' && (
          <div className="hscan-footer">
            ✔ Listo. El agente analizará los resultados automáticamente.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── AF Node Tree ────────────────────────────────────────────────────────────
interface AFNode {
  id: string; name: string; path: string
  parentId: string | null; childIds: string[]
  type: 'root' | 'element' | 'tag'
  state: 'idle' | 'querying' | 'done'
  toolName: string; queryCount: number; ts: string
  loaded: boolean
  collapsed: boolean
  tagName?: string   // PI point name (only for type:'tag')
  uom?: string       // unit of measure
}

function parseToolPath(preview: string): string | null {
  const m = preview.match(/element_path=(?:'([^']*)'|"([^"]*)"|([^\s,]+))/)
  if (!m) return null
  const val = (m[1] ?? m[2] ?? m[3] ?? '').trim()
  if (!val || val === 'None' || val === 'null') return null
  return val
}

function buildAfTree(events: ToolEvent[]): Map<string, AFNode> {
  const map = new Map<string, AFNode>()
  map.set('__root__', {
    id: '__root__', name: 'PI ROOT', path: '',
    parentId: null, childIds: [], type: 'root',
    state: 'idle', toolName: '', queryCount: 0, ts: '', loaded: true, collapsed: false,
  })
  let lastPath: string | null = null
  for (const ev of events) {
    if (!ev.name.startsWith('pi_')) continue
    if (ev.type === 'tool_call') {
      lastPath = parseToolPath(ev.preview)
      if (!lastPath) {
        const root = map.get('__root__')!
        map.set('__root__', { ...root, state: 'querying', toolName: ev.name, ts: ev.timestamp, queryCount: root.queryCount + 1 })
        continue
      }
      const segs = lastPath.split(/[\/\\]+/).filter(Boolean)
      let parentId = '__root__'
      let built = ''
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]
        built = built ? `${built}/${seg}` : seg
        const nid = `n:${built}`
        const isLast = i === segs.length - 1
        if (!map.has(nid)) {
          map.set(nid, {
            id: nid, name: seg, path: built, parentId,
            childIds: [], type: 'element',
            state: isLast ? 'querying' : 'done',
            toolName: isLast ? ev.name : '', queryCount: isLast ? 1 : 0, ts: isLast ? ev.timestamp : '',
            loaded: false, collapsed: false,
          })
          const parent = map.get(parentId)!
          if (!parent.childIds.includes(nid))
            map.set(parentId, { ...parent, childIds: [...parent.childIds, nid] })
        } else if (isLast) {
          const n = map.get(nid)!
          map.set(nid, { ...n, state: 'querying', toolName: ev.name, queryCount: n.queryCount + 1, ts: ev.timestamp })
        }
        parentId = nid
      }
    } else if (ev.type === 'tool_result') {
      const doneId = lastPath ? `n:${lastPath}` : '__root__'
      const n = map.get(doneId)
      if (n?.state === 'querying') map.set(doneId, { ...n, state: 'done' })
    }
  }
  return map
}

function getRelatedIds(nodes: Map<string, AFNode>, targetId: string): Set<string> {
  const ids = new Set<string>([targetId])
  let cur: AFNode | undefined = nodes.get(targetId)
  while (cur?.parentId) { ids.add(cur.parentId); cur = nodes.get(cur.parentId) }
  const q = [...(nodes.get(targetId)?.childIds ?? [])]
  while (q.length) {
    const cid = q.shift()!; ids.add(cid)
    nodes.get(cid)?.childIds.forEach(d => q.push(d))
  }
  return ids
}

// ─── SVG Node Graph layout ────────────────────────────────────────────────────
function countLeaves(id: string, nodes: Map<string, AFNode>): number {
  const node = nodes.get(id)
  if (!node || node.childIds.length === 0) return 1
  return node.childIds.reduce((s, c) => s + countLeaves(c, nodes), 0)
}

function computeLayout(
  rootId: string,
  nodes: Map<string, AFNode>,
  hGap = 84,
  vGap = 88,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  function place(id: string, left: number, depth: number): number {
    const node = nodes.get(id)
    if (!node) return left + hGap
    // If collapsed or no children, treat as leaf
    if (node.collapsed || node.childIds.length === 0) {
      pos.set(id, { x: left + hGap / 2, y: depth * vGap + 40 })
      return left + hGap
    }
    const start = left
    let cur = left
    for (const cid of node.childIds) cur = place(cid, cur, depth + 1)
    pos.set(id, { x: (start + cur) / 2, y: depth * vGap + 40 })
    return cur
  }
  place(rootId, 0, 0)
  return pos
}

function bezierEdge(x1: number, y1: number, x2: number, y2: number): string {
  const cy = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`
}

// ─── PI Node Graph (SVG) ──────────────────────────────────────────────────────
function nodeDisplayLabel(node: AFNode): string {
  if (node.type === 'tag') return `⟡ ${node.name}${node.uom ? ' [' + node.uom + ']' : ''}`
  if (!node.path) return node.name
  const parts = node.path.replace(/\\/g, '/').split('/').filter(p => p.trim())
  const tail = parts.slice(-2)
  return tail.length === 2 ? tail.join(' / ') : node.name
}

function PiNodeGraph({
  nodes, focusedId, onFocus, onExpand, onCollapse, onLoadTags, selectedId, onSelect,
}: {
  nodes: Map<string, AFNode>
  focusedId: string
  onFocus: (id: string) => void
  onExpand: (node: AFNode) => void
  onCollapse: (node: AFNode) => void
  onLoadTags: (node: AFNode) => void
  selectedId: string | null
  onSelect: (node: AFNode) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // ── Zoom / pan state ──────────────────────────────────────────────
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // Refs let wheel/drag handlers read latest values without stale closures
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const dragging = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Reset zoom+pan when focusedId changes
  useEffect(() => {
    setZoom(1); setPan({ x: 0, y: 0 })
    zoomRef.current = 1; panRef.current = { x: 0, y: 0 }
  }, [focusedId])

  const resetView = useCallback(() => {
    setZoom(1); setPan({ x: 0, y: 0 })
    zoomRef.current = 1; panRef.current = { x: 0, y: 0 }
  }, [])

  // Zoom toward mouse cursor position
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 0.9
    const oldZoom = zoomRef.current
    const newZoom = Math.min(8, Math.max(0.15, oldZoom * factor))
    // The <g> transform is translate(pan.x+170, pan.y+40) scale(zoom)
    // Keep the SVG-space point under the cursor fixed after zoom:
    const svgPtX = (mx - (panRef.current.x + 170)) / oldZoom
    const svgPtY = (my - (panRef.current.y + 40)) / oldZoom
    const newPan = {
      x: mx - svgPtX * newZoom - 170,
      y: my - svgPtY * newZoom - 40,
    }
    zoomRef.current = newZoom
    panRef.current = newPan
    setZoom(newZoom)
    setPan(newPan)
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 2) return
    e.preventDefault()
    setIsDragging(true)
    dragging.current = { startX: e.clientX, startY: e.clientY, panX: panRef.current.x, panY: panRef.current.y }
    const onMove = (me: MouseEvent) => {
      if (!dragging.current) return
      const newPan = {
        x: dragging.current.panX + (me.clientX - dragging.current.startX),
        y: dragging.current.panY + (me.clientY - dragging.current.startY),
      }
      panRef.current = newPan
      setPan(newPan)
    }
    const onUp = () => {
      dragging.current = null
      setIsDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const positions = useMemo(
    () => computeLayout(focusedId, nodes),
    [focusedId, nodes],
  )

  const relatedIds = useMemo(
    () => hoveredId ? getRelatedIds(nodes, hoveredId) : new Set<string>(),
    [hoveredId, nodes],
  )

  if (positions.size === 0) return null

  const stateCol = (n: AFNode, lit: boolean) => {
    if (n.type === 'tag')                 return lit ? '#d080ff' : '#7030a0'
    if (lit)                              return '#00c8ff'
    if (n.state === 'querying')           return '#ffb700'
    if (n.type === 'root')                return '#00c8ff'
    if (n.state === 'done' && n.queryCount > 0) return '#00ff41'
    return '#2a4060'
  }

  return (
    <svg
      ref={svgRef}
      style={{ width: '100%', height: '100%', display: 'block', minHeight: 160, cursor: isDragging ? 'grabbing' : 'grab' }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onContextMenu={e => e.preventDefault()}
    >
      <defs>
        <filter id="glowC" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glowY" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g transform={`translate(${pan.x + 170},${pan.y + 40}) scale(${zoom})`}>

      {/* ── Background: double-click to reset pan/zoom ── */}
      <rect x={-9999} y={-9999} width={19998} height={19998}
        fill="transparent" onDoubleClick={resetView} />

      {/* ── Edges ── */}
      {[...positions.entries()].flatMap(([id, p]) => {
        const node = nodes.get(id)!
        return node.childIds
          .filter(cid => positions.has(cid))
          .map(cid => {
            const cp = positions.get(cid)!
            const lit = relatedIds.has(id) && relatedIds.has(cid)
            return (
              <path
                key={`e-${id}-${cid}`}
                d={bezierEdge(p.x, p.y, cp.x, cp.y)}
                fill="none"
                stroke={lit ? '#00c8ff' : 'rgba(0,200,255,0.13)'}
                strokeWidth={lit ? 1.8 : 0.9}
                filter={lit ? 'url(#glowC)' : undefined}
              />
            )
          })
      })}

      {/* ── Nodes ── */}
      {[...positions.entries()].map(([id, p]) => {
        const node = nodes.get(id)!
        const lit = relatedIds.has(id)
        const col = stateCol(node, lit)
        const isTag = node.type === 'tag'
        const querying = node.state === 'querying'
        const isRoot = node.type === 'root'
        const R = isRoot ? 24 : isTag ? 13 : 19
        const canExpand = !node.loaded && !isRoot && !isTag
        const canLoadTags = !isTag && !isRoot && node.loaded && node.type === 'element' &&
          !querying && node.childIds.length === 0
        const canCollapse = !isTag && node.loaded && node.childIds.length > 0 && !node.collapsed && !isRoot
        const canUnCollapse = !isTag && node.loaded && node.childIds.length > 0 && node.collapsed && !isRoot
        const canDrill = !isTag && node.loaded && node.childIds.length > 0 && !node.collapsed
        const isSelected = id === selectedId
        const shortName = node.name.length > 13 ? node.name.slice(0, 12) + '…' : node.name

        return (
          <g
            key={id}
            transform={`translate(${p.x},${p.y})`}
            style={{ cursor: (canExpand || canDrill || canUnCollapse || canLoadTags || isTag) ? 'pointer' : 'default' }}
            onMouseEnter={() => setHoveredId(id)}
            onMouseLeave={() => setHoveredId(null)}
            onDoubleClick={e => e.stopPropagation()}
            onClick={() => {
              if (isRoot) return
              if (isTag) { onSelect(node); return }
              if (canExpand) onExpand(node)
              else if (canLoadTags) onLoadTags(node)
              else if (canUnCollapse) onCollapse(node)
              else if (canDrill) onFocus(id)
            }}
          >
            {/* AI scanning animation rings for querying */}
            {querying && (<>
              <circle r={R + 7}  fill="none" stroke="#ffb700" strokeWidth="1.4"
                opacity="0.7" className="svg-pulse-ring svg-ring-1" />
              <circle r={R + 14} fill="none" stroke="#ffb700" strokeWidth="0.9"
                opacity="0.45" className="svg-pulse-ring svg-ring-2" />
              <circle r={R + 21} fill="none" stroke="#00c8ff" strokeWidth="0.6"
                opacity="0.25" className="svg-pulse-ring svg-ring-3" />
            </>)}
            {/* Selected ring */}
            {isSelected && (
              <circle r={R + 10} fill="none" stroke="#00ff41" strokeWidth="1.2"
                strokeDasharray="4 3" opacity="0.8" />
            )}
            {/* Glow halo */}
            {(lit || querying) && (
              <circle r={R + 5}
                fill={querying ? 'rgba(255,183,0,0.07)' : isTag ? 'rgba(208,128,255,0.08)' : 'rgba(0,200,255,0.07)'}
                stroke={querying ? 'rgba(255,183,0,0.35)' : isTag ? 'rgba(208,128,255,0.4)' : 'rgba(0,200,255,0.35)'}
                strokeWidth="1"
                filter={`url(#glow${querying ? 'Y' : 'C'})`}
              />
            )}

            {/* ── TAG node: diamond shape ── */}
            {isTag ? (
              <>
                <rect
                  x={-R} y={-R} width={R * 2} height={R * 2}
                  transform="rotate(45)"
                  fill="rgba(3,0,16,0.96)"
                  stroke={col} strokeWidth={isSelected ? 2 : 1.2}
                />
                <text textAnchor="middle" dominantBaseline="central"
                  fontSize="9" fill={col} fontFamily="monospace">◇</text>
              </>
            ) : (
              <>
                {/* Main circle */}
                <circle
                  r={R}
                  fill={isRoot ? 'rgba(0,20,44,0.96)' : 'rgba(3,9,22,0.96)'}
                  stroke={col}
                  strokeWidth={lit || querying ? 2 : 1.2}
                  className={querying ? 'svg-node-querying' : ''}
                />
                {/* Inner decoration ring */}
                <circle r={R - 5} fill="none" stroke={`${col}28`} strokeWidth="0.7" />
                {/* State icon */}
                <text textAnchor="middle" dominantBaseline="central"
                  fontSize={isRoot ? 13 : 10} fill={col} fontFamily="monospace"
                  className={querying ? 'svg-icon-querying' : ''}>
                  {isRoot ? '⬡' : querying ? '⬡' : node.state === 'done' && node.queryCount > 0 ? '◈' : '◦'}
                </text>
              </>
            )}

            {/* Label */}
            <text y={R + 13} textAnchor="middle" fontSize={isTag ? '7.5' : '8.5'}
              fontFamily="'JetBrains Mono', monospace" letterSpacing="0.02em"
              fill={lit ? (isTag ? '#d080ff' : '#00c8ff') : querying ? '#ffb700' : isTag ? '#7030a0' : '#4a6880'}>
              {shortName}
            </text>
            {/* Tag UOM */}
            {isTag && node.uom && (
              <text y={R + 23} textAnchor="middle" fontSize="6.5" fontFamily="monospace"
                fill="rgba(208,128,255,0.5)">{node.uom}</text>
            )}
            {/* Hints */}
            {canExpand && (
              <text y={R + 23} textAnchor="middle" fontSize="7.5" fontFamily="monospace"
                fill={lit ? 'rgba(255,183,0,0.9)' : 'rgba(255,183,0,0.45)'}>
                ＋ expandir
              </text>
            )}
            {canLoadTags && (
              <text y={R + 23} textAnchor="middle" fontSize="7.5" fontFamily="monospace"
                fill={lit ? 'rgba(208,128,255,0.9)' : 'rgba(208,128,255,0.4)'}>
                ◇ ver tags
              </text>
            )}
            {querying && (
              <text y={R + 23} textAnchor="middle" fontSize="7" fontFamily="monospace"
                fill="#ffb700" className="svg-icon-querying">
                cargando…
              </text>
            )}
            {canDrill && (
              <text y={R + 23} textAnchor="middle" fontSize="7.5" fontFamily="monospace"
                fill={lit ? 'rgba(0,200,255,0.65)' : 'rgba(0,200,255,0.22)'}>
                {node.childIds.length} ›
              </text>
            )}
            {canUnCollapse && (
              <text y={R + 23} textAnchor="middle" fontSize="7.5" fontFamily="monospace"
                fill={lit ? 'rgba(0,255,120,0.8)' : 'rgba(0,255,120,0.35)'}>
                ＋ mostrar
              </text>
            )}
            {/* Collapse button */}
            {hoveredId === id && canCollapse && (
              <g
                transform={`translate(${R - 3},${R - 3})`}
                style={{ cursor: 'pointer' }}
                onClick={e => { e.stopPropagation(); onCollapse(node) }}
              >
                <circle r="7" fill="rgba(0,12,30,0.95)" stroke="rgba(0,200,255,0.6)" strokeWidth="1.1" />
                <text textAnchor="middle" dominantBaseline="central"
                  fontSize="11" fill="rgba(0,200,255,0.9)" fontFamily="monospace">−</text>
              </g>
            )}
            {/* Query count badge */}
            {node.queryCount > 0 && !querying && !isTag && (
              <g transform={`translate(${R - 3},${-R + 3})`}>
                <circle r="6" fill="#001510" stroke="#00ff41" strokeWidth="0.9" />
                <text textAnchor="middle" dominantBaseline="central"
                  fontSize="6.5" fill="#00ff41" fontFamily="monospace">
                  {node.queryCount}
                </text>
              </g>
            )}
            {/* Pin / select badge for element nodes */}
            {hoveredId === id && !isRoot && !isTag && (
              <g
                transform={`translate(${-R + 3},${-R + 3})`}
                style={{ cursor: 'pointer' }}
                onClick={e => { e.stopPropagation(); onSelect(node) }}
              >
                <circle r="7" fill="rgba(0,12,30,0.95)"
                  stroke={isSelected ? '#00ff41' : '#00c8ff'} strokeWidth="1.3" />
                <text textAnchor="middle" dominantBaseline="central"
                  fontSize="10" fill={isSelected ? '#00ff41' : '#00c8ff'}
                  fontFamily="monospace">
                  {isSelected ? '−' : '+'}
                </text>
              </g>
            )}
            {/* Tag select hint on hover */}
            {hoveredId === id && isTag && (
              <text y={R + 33} textAnchor="middle" fontSize="7" fontFamily="monospace"
                fill={isSelected ? '#00ff41' : 'rgba(208,128,255,0.7)'}>
                {isSelected ? '× deseleccionar' : '+ contexto IA'}
              </text>
            )}
          </g>
        )
      })}
      </g>
    </svg>
  )
}

// ─── PI Tree Panel ────────────────────────────────────────────────────────────

/** Renders a flat indented list of all loaded nodes, sorted by path depth */
function HierarchyList({ nodes, selectedId, onSelect, onExpand, onLoadTags }: {
  nodes: Map<string, AFNode>
  selectedId: string | null
  onSelect: (node: AFNode) => void
  onExpand: (node: AFNode) => void
  onLoadTags: (node: AFNode) => void
}) {
  // Build display order: BFS from root preserving tree order
  const order: AFNode[] = []
  const visited = new Set<string>()
  const queue: string[] = ['__root__']
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = nodes.get(id)
    if (!node) continue
    if (node.type !== 'root') order.push(node)
    if (!node.collapsed) {
      for (const cid of node.childIds) queue.push(cid)
    }
  }

  // Compute depth for indentation
  const depthOf = (node: AFNode): number => {
    let d = 0; let cur: AFNode | undefined = node
    while (cur?.parentId && cur.parentId !== '__root__') {
      d++; cur = nodes.get(cur.parentId)
    }
    return d
  }

  return (
    <div className="hi-list">
      {order.map(node => {
        const depth = depthOf(node)
        const isSelected = node.id === selectedId
        const isTag = node.type === 'tag'
        const querying = node.state === 'querying'
        const canExpand = !node.loaded && !isTag
        const canLoadTags = !isTag && node.loaded && node.childIds.length === 0 && !querying
        const hasChildren = node.childIds.length > 0
        const isCollapsed = node.collapsed

        return (
          <div
            key={node.id}
            className={`hi-row${isSelected ? ' hi-row-selected' : ''}${isTag ? ' hi-row-tag' : ''}`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => {
              if (isTag) { onSelect(node); return }
              if (canExpand) { onExpand(node); return }
              if (canLoadTags) { onLoadTags(node); return }
              onSelect(node)
            }}
          >
            {/* Expand / collapse / leaf icon */}
            <span className="hi-icon">
              {querying ? '⟳' : isTag ? '◇' : canExpand ? '›' : hasChildren && !isCollapsed ? '⌄' : hasChildren ? '›' : '·'}
            </span>
            <span className="hi-name">{node.name}</span>
            {isTag && node.uom && <span className="hi-uom">{node.uom}</span>}
            {querying && <span className="hi-loading">…</span>}
            {isSelected && <span className="hi-pin">✦</span>}
          </div>
        )
      })}
      {order.length === 0 && (
        <div className="hi-empty">Cargando jerarquía…</div>
      )}
    </div>
  )
}

function PiTreePanel({ nodes, tools, toolsOpen, onToggle, selectedId, onSelect, onExpandNode, onCollapseNode, onLoadTags }: {
  nodes: Map<string, AFNode>; tools: ToolEvent[]
  toolsOpen: boolean; onToggle: () => void
  selectedId: string | null; onSelect: (node: AFNode) => void
  onExpandNode: (node: AFNode) => void
  onCollapseNode: (node: AFNode) => void
  onLoadTags: (node: AFNode) => void
}) {
  const [focusedId, setFocusedId] = useState('__root__')
  const [fsTree, setFsTree] = useState(false)
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const evEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { evEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [tools])
  useEffect(() => { if (!nodes.has(focusedId)) setFocusedId('__root__') }, [nodes, focusedId])

  // Close fullscreen on Escape
  useEffect(() => {
    if (!fsTree) return
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setFsTree(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fsTree])

  const handleFocus = useCallback((id: string) => {
    setFocusedId(id)
    const node = nodes.get(id)
    if (node && !node.loaded && node.type !== 'root') onExpandNode(node)
  }, [nodes, onExpandNode])

  const focusedNode = nodes.get(focusedId) ?? nodes.get('__root__')
  const hasTree = nodes.size > 1
  const queryingCount = [...nodes.values()].filter(n => n.state === 'querying').length

  const breadcrumb: AFNode[] = []
  let cur: AFNode | undefined = focusedNode
  while (cur) { breadcrumb.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : undefined }

  const panelRef = useRef<HTMLDivElement>(null)

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelRef.current?.offsetWidth ?? 340
    const onMove = (me: MouseEvent) => {
      const newW = Math.max(220, Math.min(700, startW + (startX - me.clientX)))
      if (panelRef.current) panelRef.current.style.width = `${newW}px`
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  if (!toolsOpen) {
    return (
      <button className="tool-reopen-btn" onClick={onToggle} title="Mostrar PI AF Tree">
        <span className="tool-reopen-arrow">◀</span>
        {queryingCount > 0
          ? <span className="tool-reopen-badge" style={{ background: 'var(--yellow)', color: '#000' }}>{queryingCount}</span>
          : nodes.size > 1 && <span className="tool-reopen-badge">{nodes.size - 1}</span>
        }
      </button>
    )
  }

  return (
    <div className={`tool-panel${fsTree ? ' tool-panel-fs' : ''}`} ref={panelRef}>
      {/* Resize handle (hidden in fullscreen) */}
      {!fsTree && <div className="pi-resize-handle" onMouseDown={startResize} title="Arrastrar para redimensionar" />}
      {/* Header */}
      <div className="pi-hdr">
        <span className="pi-hdr-logo">⬡</span>
        <span className="pi-hdr-title">PI AF TREE</span>
        <div className="pi-hdr-actions">
          {/* View toggle */}
          <button
            className={`pi-hdr-btn${view === 'graph' ? ' pi-hdr-btn-active' : ''}`}
            onClick={() => setView('graph')} title="Vista gráfica">⬡</button>
          <button
            className={`pi-hdr-btn${view === 'list' ? ' pi-hdr-btn-active' : ''}`}
            onClick={() => setView('list')} title="Lista jerárquica">☰</button>
          {view === 'graph' && focusedId !== '__root__' && (
            <button className="pi-hdr-btn" onClick={() =>
              handleFocus(nodes.get(focusedId)?.parentId ?? '__root__')
            } title="Subir nivel">↑</button>
          )}
          <button className="pi-hdr-btn" onClick={() => setFsTree(f => !f)}
            title={fsTree ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}>
            {fsTree ? '⊡' : '⊞'}
          </button>
          {!fsTree && <button className="pi-hdr-btn" onClick={onToggle} title="Colapsar">▶</button>}
        </div>
      </div>

      {/* Breadcrumb — graph view only */}
      {view === 'graph' && (
        <div className="pi-crumb">
          {breadcrumb.map((n, i) => (
            <span key={n.id}>
              {i > 0 && <span className="pi-crumb-sep"> › </span>}
              <span
                className={`pi-crumb-item${n.id === focusedNode?.id ? ' pi-crumb-active' : ''}`}
                onClick={() => handleFocus(n.id)}
              >{n.name}</span>
            </span>
          ))}
        </div>
      )}

      {/* Section label for list view */}
      {view === 'list' && (
        <div className="pi-divider" style={{ marginTop: 0 }}>── HIERARCHY LIST ──</div>
      )}

      {/* Graph / List body */}
      <div className="pi-graph-body">
        {view === 'graph' ? (
          hasTree ? (
            <PiNodeGraph
              nodes={nodes}
              focusedId={focusedId}
              onFocus={handleFocus}
              onExpand={onExpandNode}
              onCollapse={onCollapseNode}
              onLoadTags={onLoadTags}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : (
            <div className="pi-empty">
              <div className="pi-empty-icon">◌</div>
              <div>Cargando árbol PI…</div>
              <div>Haz click en un nodo para explorar</div>
            </div>
          )
        ) : (
          <HierarchyList
            nodes={nodes}
            selectedId={selectedId}
            onSelect={onSelect}
            onExpand={onExpandNode}
            onLoadTags={onLoadTags}
          />
        )}
      </div>

      {/* Divider */}
      <div className="pi-divider">── TOOL EVENTS ──</div>

      {/* Events */}
      <div className="pi-evlog">
        {tools.slice(-8).map(ev => (
          <div key={ev.id} className={`pi-ev pi-ev-${ev.type}`}>
            <span className="pi-ev-icon">{ev.type === 'tool_call' ? '⚡' : '✓'}</span>
            <span className="pi-ev-name">{ev.name.replace('pi_fetch_', '').replace('pi_', '').replace(/_/g, ' ')}</span>
            <span className="pi-ev-ts">{ev.timestamp}</span>
          </div>
        ))}
        <div ref={evEndRef} />
      </div>
    </div>
  )
}

// ─── Docs Modal ──────────────────────────────────────────────────────────────
const DOCS_SECTIONS = [
  {
    id: 'intro',
    icon: '⬡',
    title: '¿Qué es KEMEX Data Science?',
    content: `Es tu asistente inteligente de planta. Puedes hacerle preguntas en español sobre los datos de tus máquinas y sensores en tiempo real, y él se encarga de buscar, analizar y explicarte todo.

No necesitas saber programación ni conocer los nombres técnicos de los tags. Solo escribe lo que quieres saber, igual que si le hablaras a un compañero de trabajo.`,
    examples: [
      { label: 'Pregunta libre', text: '¿Cómo estuvo la temperatura de la Reflow Oven L1 ayer?' },
      { label: 'Diagnóstico', text: 'Dime si hay alguna máquina con señales irregulares esta semana' },
      { label: 'Comparación', text: 'Compara la velocidad de las Paste Printers del turno matutino vs vespertino' },
    ],
  },
  {
    id: 'chat',
    icon: '💬',
    title: 'Cómo usar el Chat',
    content: `El chat es la forma principal de interactuar con la IA. Escribe tu pregunta en el cuadro de texto en la parte inferior y presiona ENTER o el botón ENVIAR.

La IA puede:
• Obtener datos históricos de cualquier sensor o tag
• Calcular promedios, máximos, mínimos y tendencias
• Generar gráficas automáticamente
• Detectar anomalías o comportamientos fuera de rango
• Responder preguntas de diagnóstico de equipos

Si la IA necesita buscar datos, verás los nodos del árbol PI parpadeando mientras trabaja.`,
    examples: [
      { label: 'Datos históricos', text: 'Muéstrame los valores de temperatura de la Reflow Oven de ayer entre 8am y 4pm' },
      { label: 'Gráfica', text: 'Genera una gráfica de la presión del squeegee en la línea 2 de los últimos 3 días' },
      { label: 'Detección de anomalías', text: '¿Algún sensor tuvo un flatline (señal plana) en las últimas 24 horas?' },
    ],
  },
  {
    id: 'tree',
    icon: '⬡',
    title: 'PI AF Tree — Vista Gráfica',
    content: `El panel derecho muestra el árbol de activos de tu planta (PI AF Tree). Cada círculo es una máquina, línea o área.

Cómo navegar:
• Haz clic en un nodo para expandir sus hijos
• Cuando un nodo ya está expandido y no tiene más hijos, aparece "◇ ver tags" — haz clic para ver los sensores (tags) de esa máquina
• Los nodos en amarillo están siendo consultados por la IA
• Los nodos en verde ya tienen datos cargados
• Los diamantes morados (◇) son tags individuales (sensores)
• Rueda del ratón para hacer zoom, arrastra para mover la vista
• Doble clic en el fondo para recentrar la vista`,
    examples: [
      { label: 'Expandir árbol', text: 'Haz clic sobre "Linea 1 Left" para ver sus máquinas' },
      { label: 'Ver sensores', text: 'Haz clic sobre "B2_L1L Paste Printer" (cuando muestre ◇ ver tags) para ver sus tags' },
      { label: 'Pantalla completa', text: 'Presiona ⊞ en la esquina del panel para modo pantalla completa. Presiona Esc para salir.' },
    ],
  },
  {
    id: 'hierarchy',
    icon: '☰',
    title: 'PI AF Tree — Lista Jerárquica',
    content: `La vista de lista muestra toda la jerarquía en forma de árbol de texto indentado. Es útil cuando quieres buscar visualmente una máquina específica sin navegar el gráfico.

Cómo usarla:
• Haz clic en el ícono ☰ en la cabecera del panel derecho
• Los nodos con › aún no están cargados — haz clic para expandirlos
• Los nodos con · ya están al nivel más profundo — haz clic para cargar sus tags
• Los tags aparecen como ◇ con su unidad de medida (e.g. °C, PSI)
• La selección se comparte con la vista gráfica`,
    examples: [
      { label: 'Cambiar vista', text: 'Haz clic en ☰ para ver la lista; haz clic en ⬡ para volver al gráfico' },
      { label: 'Buscar máquina', text: 'Desplázate por la lista hasta encontrar la máquina y haz clic para expandirla' },
    ],
  },
  {
    id: 'context',
    icon: '✦',
    title: 'Seleccionar contexto para la IA',
    content: `Puedes "apuntarle" a la IA a una máquina o sensor específico antes de hacer una pregunta. Esto le ayuda a entender exactamente de qué equipo estás hablando.

Cómo hacerlo:
• En la vista gráfica: cuando pases el cursor sobre un nodo, aparece un ícono + en la esquina superior izquierda — haz clic para seleccionarlo
• En la vista de lista: haz clic sobre cualquier nodo o tag para seleccionarlo
• Verás una pastilla verde en la parte inferior del chat con el nombre del elemento seleccionado
• Al enviar un mensaje, la IA recibirá automáticamente la ruta completa de ese elemento
• Haz clic en la pastilla o en × para deseleccionarlo`,
    examples: [
      { label: 'Seleccionar máquina', text: 'Selecciona "B2_L1L Paste Printer" y pregunta: ¿Cómo estuvo la presión ayer?' },
      { label: 'Seleccionar tag', text: 'Selecciona un tag ◇ de temperatura y pregunta: ¿Estuvo dentro del rango normal esta semana?' },
    ],
  },
  {
    id: 'scan',
    icon: '⬡',
    title: 'Plant Health Scan — Diagnóstico de toda la planta',
    content: `El botón SCAN en la barra superior lanza un análisis automático de toda la planta. La IA recorre todas las líneas y máquinas, recolecta datos recientes y genera un reporte de salud.

Pasos:
1. Haz clic en ⬡ SCAN
2. (Opcional) Escribe un plan de análisis — por ejemplo: "Enfócate en anomalías de temperatura"
3. Haz clic en INICIAR SCAN
4. Espera a que el progreso llegue al 100%
5. La IA analizará automáticamente los resultados y te dará un resumen

Después del scan:
• Aparece el botón 📊 DATOS para ver la tabla completa de valores recolectados
• Puedes seguir haciendo preguntas al chat basadas en los datos del scan`,
    examples: [
      { label: 'Scan general', text: 'Haz clic en ⬡ SCAN → INICIAR SCAN (sin plan) para un análisis completo' },
      { label: 'Scan enfocado', text: 'Escribe "Solo Reflow Ovens — busca perfiles de temperatura fuera de rango" antes de iniciar' },
    ],
  },
  {
    id: 'tips',
    icon: '💡',
    title: 'Consejos y buenas prácticas',
    content: `• Sé específico con las fechas: en lugar de "ayer", prueba "el 10 de mayo entre 6am y 2pm"
• Puedes pedir gráficas directamente: "grafica la temperatura de…"
• Si la respuesta fue muy larga, pregunta: "resume lo más importante"
• Puedes ejecutar código Python que la IA genere — aparece el botón ▶ EJECUTAR bajo el bloque de código
• El tema visual se cambia con ○ LIGHT / ◑ DARK en la barra superior
• Usa 🗑 LIMPIAR para borrar archivos de scans anteriores y liberar espacio`,
    examples: [
      { label: 'Con fecha exacta', text: 'Dame los datos de vibración del 8 de mayo de 7am a 3pm' },
      { label: 'Pedir resumen', text: 'De todo lo que analizaste, ¿cuál es la máquina con más riesgo?' },
    ],
  },
]

function DocsModal({ onClose }: { onClose: () => void }) {
  const [activeId, setActiveId] = useState('intro')
  const section = DOCS_SECTIONS.find(s => s.id === activeId) ?? DOCS_SECTIONS[0]

  // Close on Escape
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="docs-overlay" onClick={onClose}>
      <div className="docs-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="docs-hdr">
          <span className="docs-hdr-logo">⬡</span>
          <span className="docs-hdr-title">DOCUMENTACIÓN</span>
          <span className="docs-hdr-sub">Guía de uso — KEMEX Data Science</span>
          <button className="docs-close" onClick={onClose}>✕</button>
        </div>

        <div className="docs-body">
          {/* Sidebar nav */}
          <nav className="docs-nav">
            {DOCS_SECTIONS.map(s => (
              <button
                key={s.id}
                className={`docs-nav-item${s.id === activeId ? ' docs-nav-active' : ''}`}
                onClick={() => setActiveId(s.id)}
              >
                <span className="docs-nav-icon">{s.icon}</span>
                <span className="docs-nav-label">{s.title}</span>
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="docs-content">
            <div className="docs-section-title">
              <span className="docs-section-icon">{section.icon}</span>
              {section.title}
            </div>

            {/* Description */}
            <div className="docs-text">
              {section.content.split('\n').map((line, i) => (
                line.trim() === '' ? <div key={i} className="docs-gap" /> :
                line.startsWith('•') ? <div key={i} className="docs-bullet">{line}</div> :
                <div key={i} className="docs-p">{line}</div>
              ))}
            </div>

            {/* Examples */}
            {section.examples.length > 0 && (
              <div className="docs-examples">
                <div className="docs-ex-title">Ejemplos</div>
                {section.examples.map((ex, i) => (
                  <div key={i} className="docs-ex-card">
                    <div className="docs-ex-label">{ex.label}</div>
                    <div className="docs-ex-text">❯ {ex.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="docs-footer">
          <span>Presiona <kbd>Esc</kbd> para cerrar</span>
          <span className="docs-footer-brand">⬡ KEMEX Data Science — Kimball Electronics</span>
        </div>
      </div>
    </div>
  )
}

// ─── Plan Modal ───────────────────────────────────────────────────────────────
const PLAN_EXAMPLES = [
  'Enfócate en las Reflow Ovens — analiza temperaturas y perfiles térmicos',
  'Identifica qué líneas tuvieron más paros o señales flatline en sensores de velocidad',
  'Analiza solo las Paste Printers: presión del squeegee, velocidad y altura de pasta',
  'Compara el rendimiento entre turnos buscando patrones en las últimas 24h',
  'Detecta posibles problemas de mantenimiento preventivo vencido basándote en los flatlines',
]

function PlanModal({
  onStart,
  onCancel,
}: {
  onStart: (plan: string, fromDt: string, toDt: string) => void
  onCancel: () => void
}) {
  const [plan, setPlan] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate]     = useState('')
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { textRef.current?.focus() }, [])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onCancel()
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onStart(plan, fromDate, toDate)
  }

  const dateError = fromDate && toDate && toDate <= fromDate
    ? 'La fecha de inicio debe ser anterior a la fecha de fin'
    : null

  return (
    <div className="plan-overlay" onClick={onCancel}>
      <div className="plan-modal" onClick={e => e.stopPropagation()} onKeyDown={handleKey}>

        <div className="plan-hdr">
          <span className="plan-icon">🎯</span>
          <span className="plan-title">PLAN DE ANÁLISIS</span>
          <button className="plan-close" onClick={onCancel}>✕</button>
        </div>

        <div className="plan-body">
          <p className="plan-desc">
            Opcionalmente, define un enfoque para el análisis de la IA.<br/>
            Si lo dejas vacío, se realizará el análisis general de salud de planta.
          </p>

          {/* ── Date range ── */}
          <div className="plan-daterow">
            <div className="plan-datefield">
              <label className="plan-datelabel">📅 Desde</label>
              <input
                type="datetime-local"
                className={`plan-dateinput${dateError ? ' plan-dateinput-err' : ''}`}
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
              />
            </div>
            <div className="plan-datefield">
              <label className="plan-datelabel">📅 Hasta</label>
              <input
                type="datetime-local"
                className={`plan-dateinput${dateError ? ' plan-dateinput-err' : ''}`}
                value={toDate}
                onChange={e => setToDate(e.target.value)}
              />
            </div>
            <div className="plan-datehint">
              {dateError
                ? <span className="plan-dateerr">{dateError}</span>
                : (!fromDate && !toDate)
                  ? <span>Sin rango → últimas 24 h</span>
                  : (fromDate && !toDate) || (!fromDate && toDate)
                  ? <span className="plan-dateerr">Completa ambas fechas</span>
                  : null}
            </div>
          </div>

          <textarea
            ref={textRef}
            className="plan-textarea"
            value={plan}
            onChange={e => setPlan(e.target.value)}
            placeholder="Ej: Enfócate en las Reflow Ovens y analiza si hay problemas de temperatura en zonas específicas…"
            rows={4}
          />

          <div className="plan-examples-label">Ejemplos rápidos:</div>
          <div className="plan-examples">
            {PLAN_EXAMPLES.map((ex, i) => (
              <button
                key={i}
                className="plan-example-btn"
                onClick={() => setPlan(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        <div className="plan-footer">
          <button className="plan-btn-skip" onClick={() => onStart('', '', '')}>
            ⬡ Sin plan — análisis general
          </button>
          <button
            className="plan-btn-start"
            disabled={!!dateError || (!!fromDate !== !!toDate)}
            onClick={() => onStart(plan, fromDate, toDate)}
          >
            {plan.trim() ? '🎯 Iniciar con este plan' : '⬡ Iniciar análisis general'}
          </button>
        </div>

        <div className="plan-hint">Ctrl+Enter para iniciar · Esc para cancelar</div>
      </div>
    </div>
  )
}

// ─── Scan Data Table ──────────────────────────────────────────────────────────
interface TableRow {
  line: string; machine: string; attribute: string; tag: string
  status: string; count: number; avg: number | null
  min: number | null; max: number | null; stdev: number | null
}
interface TableData {
  scan_id: string; period: string; total_rows: number
  page: number; pages: number; rows: TableRow[]
  filters: { lines: string[]; machines: string[] }
  summary: { ok: number; no_data: number; anomaly: number }
}
interface ScanMeta {
  scan_id: string; started_at: string; lines: number; machines: number; tags: number
}

function ScanDataTable({ onClose }: { onClose: () => void }) {
  const [scanList, setScanList]     = useState<ScanMeta[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [data, setData]             = useState<TableData | null>(null)
  const [loading, setLoading]       = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [lineFilter, setLineFilter]     = useState<string>('')
  const [machineFilter, setMachineFilter] = useState<string>('')
  const [page, setPage]             = useState(1)
  const [searchText, setSearchText] = useState('')

  // Cargar lista de scans al montar
  useEffect(() => {
    fetch('/api/health-scan/list').then(r => r.json()).then((d: { scans: ScanMeta[] }) => {
      setScanList(d.scans ?? [])
      if (d.scans?.length) setSelectedId(d.scans[0].scan_id)
    }).catch(() => {})
  }, [])

  // Cargar tabla cuando cambia selección/filtros/página
  useEffect(() => {
    if (!selectedId) return
    setLoading(true)
    const params = new URLSearchParams({
      status_filter: statusFilter,
      line_filter: lineFilter,
      machine_filter: machineFilter,
      page: String(page),
      page_size: '100',
    })
    fetch(`/api/health-scan/table/${selectedId}?${params}`)
      .then(r => r.json())
      .then((d: TableData) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [selectedId, statusFilter, lineFilter, machineFilter, page])

  // Reset page on filter change
  useEffect(() => { setPage(1) }, [statusFilter, lineFilter, machineFilter, selectedId])

  const statusColor: Record<string, string> = {
    'OK': 'var(--green)',
    'NO_DATA': 'var(--dim)',
    'FLATLINE': 'var(--yellow)',
    'SPIKE': 'var(--red)',
  }
  function getStatusColor(s: string): string {
    if (s === 'OK') return 'var(--green)'
    if (s === 'NO_DATA') return 'var(--dim)'
    if (s.includes('FLATLINE') && s.includes('SPIKE')) return 'var(--red)'
    if (s.includes('FLATLINE')) return 'var(--yellow)'
    if (s.includes('SPIKE')) return 'var(--red)'
    return 'var(--cyan)'
  }
  function statusIcon(s: string): string {
    if (s === 'OK') return '✓'
    if (s === 'NO_DATA') return '–'
    if (s.includes('SPIKE')) return '⚡'
    if (s.includes('FLATLINE')) return '━'
    return '?'
  }

  const visibleRows = searchText
    ? (data?.rows ?? []).filter(r =>
        r.attribute.toLowerCase().includes(searchText.toLowerCase()) ||
        r.tag.toLowerCase().includes(searchText.toLowerCase()) ||
        r.machine.toLowerCase().includes(searchText.toLowerCase())
      )
    : (data?.rows ?? [])

  return (
    <div className="dt-overlay" onClick={onClose}>
      <div className="dt-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="dt-hdr">
          <span className="dt-title">📋 DATOS DEL ESCANEO</span>
          <span className="dt-period">{data?.period ?? '—'}</span>
          <button className="dt-close" onClick={onClose}>✕</button>
        </div>

        {/* Toolbar */}
        <div className="dt-toolbar">
          {/* Selector de scan */}
          <select
            className="dt-select"
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
          >
            {scanList.map(s => (
              <option key={s.scan_id} value={s.scan_id}>
                {s.scan_id}  ({s.machines} máq, {s.tags} tags)
              </option>
            ))}
          </select>

          {/* Filtro de estado */}
          <div className="dt-filter-group">
            {(['all','anomaly','ok','no_data'] as const).map(f => (
              <button
                key={f}
                className={`dt-filter-btn${statusFilter === f ? ' active' : ''}`}
                onClick={() => setStatusFilter(f)}
              >
                {f === 'all' ? `TODOS (${(data?.summary.ok ?? 0) + (data?.summary.no_data ?? 0) + (data?.summary.anomaly ?? 0)})`
                  : f === 'anomaly' ? `⚡ ANOMALÍAS (${data?.summary.anomaly ?? 0})`
                  : f === 'ok' ? `✓ OK (${data?.summary.ok ?? 0})`
                  : `– SIN DATOS (${data?.summary.no_data ?? 0})`}
              </button>
            ))}
          </div>

          {/* Búsqueda */}
          <input
            className="dt-search"
            placeholder="Buscar tag / atributo / máquina…"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
        </div>

        {/* Filtros de línea y máquina */}
        <div className="dt-toolbar dt-toolbar-2">
          <select className="dt-select" value={lineFilter} onChange={e => setLineFilter(e.target.value)}>
            <option value="">Todas las líneas</option>
            {(data?.filters.lines ?? []).map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select className="dt-select" value={machineFilter} onChange={e => setMachineFilter(e.target.value)}>
            <option value="">Todas las máquinas</option>
            {(data?.filters.machines ?? []).map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="dt-count">
            {loading ? 'Cargando…' : `${data?.total_rows ?? 0} filas · pág ${data?.page ?? 1}/${data?.pages ?? 1}`}
          </span>
        </div>

        {/* Tabla */}
        <div className="dt-table-wrap">
          <table className="dt-table">
            <thead>
              <tr>
                <th>Línea</th>
                <th>Máquina</th>
                <th>Atributo</th>
                <th>Estado</th>
                <th className="dt-num">Pts</th>
                <th className="dt-num">Avg</th>
                <th className="dt-num">Min</th>
                <th className="dt-num">Max</th>
                <th className="dt-num">Stdev</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, i) => (
                <tr key={i} className={`dt-row${r.status !== 'OK' && r.status !== 'NO_DATA' ? ' dt-row-anomaly' : r.status === 'NO_DATA' ? ' dt-row-nodata' : ''}`}>
                  <td className="dt-cell-dim">{r.line}</td>
                  <td>{r.machine}</td>
                  <td className="dt-cell-attr" title={r.tag}>{r.attribute}</td>
                  <td>
                    <span className="dt-status-badge" style={{ color: getStatusColor(r.status), borderColor: getStatusColor(r.status) }}>
                      {statusIcon(r.status)} {r.status}
                    </span>
                  </td>
                  <td className="dt-num">{r.count}</td>
                  <td className="dt-num">{r.avg !== null ? r.avg?.toFixed(3) : '—'}</td>
                  <td className="dt-num">{r.min !== null ? r.min?.toFixed(3) : '—'}</td>
                  <td className="dt-num">{r.max !== null ? r.max?.toFixed(3) : '—'}</td>
                  <td className="dt-num">{r.stdev !== null ? r.stdev?.toFixed(4) : '—'}</td>
                </tr>
              ))}
              {visibleRows.length === 0 && !loading && (
                <tr><td colSpan={9} className="dt-empty">Sin resultados para los filtros actuales</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {(data?.pages ?? 1) > 1 && (
          <div className="dt-pagination">
            <button className="dt-pg-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>◀</button>
            {Array.from({ length: Math.min(data!.pages, 10) }, (_, i) => {
              const p = i + 1
              return (
                <button key={p} className={`dt-pg-btn${page === p ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>
              )
            })}
            <button className="dt-pg-btn" disabled={page >= (data?.pages ?? 1)} onClick={() => setPage(p => p + 1)}>▶</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Banner ───────────────────────────────────────────────────────────────────
const BANNER = [
  '  ██╗  ██╗███████╗███╗   ███╗███████╗██╗  ██╗',
  '  ██║ ██╔╝██╔════╝████╗ ████║██╔════╝╚██╗██╔╝',
  '  █████╔╝ █████╗  ██╔████╔██║█████╗   ╚███╔╝ ',
  '  ██╔═██╗ ██╔══╝  ██║╚██╔╝██║██╔══╝   ██╔██╗ ',
  '  ██║  ██╗███████╗██║ ╚═╝ ██║███████╗██╔╝ ██╗',
  '  ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝',
  '  ███████╗ ██████╗██╗███████╗███╗   ██╗ ██████╗███████╗',
  '  ██╔════╝██╔════╝██║██╔════╝████╗  ██║██╔════╝██╔════╝',
  '  ███████╗██║     ██║█████╗  ██╔██╗ ██║██║     █████╗  ',
  '  ╚════██║██║     ██║██╔══╝  ██║╚██╗██║██║     ██╔══╝  ',
  '  ███████║╚██████╗██║███████╗██║ ╚████║╚██████╗███████╗',
  '  ╚══════╝ ╚═════╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝',
  '     PI Web API  ·  Azure AI Foundry  ·  v1.0 ',
].join('\n')

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { id: 'banner', role: 'system', content: BANNER + '\n\nConectando con Azure AI Foundry…', timestamp: now() },
  ])
  const [tools,    setTools]    = useState<ToolEvent[]>([])
  const [input,    setInput]    = useState('')
  const [status,   setStatus]   = useState<Status>({
    state: 'connecting', label: 'CONECTANDO…', model: '—', cacheInfo: '—',
  })

  const chatEndRef  = useRef<HTMLDivElement>(null)
  const chatLogRef  = useRef<HTMLDivElement>(null)
  const inputRef    = useRef<HTMLInputElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const [toolsOpen, setToolsOpen] = useState(true)
  const [lightMode, setLightMode] = useState(false)
  const [zoomedPlot, setZoomedPlot] = useState<string | null>(null)
  const [ctxNode, setCtxNode] = useState<AFNode | null>(null)
  const [scanState, setScanState] = useState<ScanState>({
    phase: 'idle', pct: 0, log: [], summary: null, error: null,
  })
  const [scanOpen, setScanOpen] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [activePlan, setActivePlan] = useState('')
  const [docsOpen, setDocsOpen] = useState(false)

  // ── Escape key closes lightbox ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setZoomedPlot(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Auto-scroll (only when user is already at the bottom) ─────────────────
  useEffect(() => {
    if (atBottom) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, atBottom])

  const handleChatScroll = useCallback(() => {
    const el = chatLogRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAtBottom(nearBottom)
  }, [])

  // ── AF Tree: AI-query nodes (derived) + user-explored nodes (state) ────────
  const aiNodes = useMemo(() => buildAfTree(tools), [tools])
  const [explorerNodes, setExplorerNodes] = useState<Map<string, AFNode>>(new Map())

  // Merge: AI nodes take precedence for state/queryCount; explorer fills in structure
  const afNodes = useMemo(() => {
    const merged = new Map<string, AFNode>(explorerNodes)
    for (const [id, n] of aiNodes) {
      const ex = merged.get(id)
      if (ex) {
        // AI node wins for state + queryCount; keep explorer's childIds if richer
        const childIds = [...new Set([...ex.childIds, ...n.childIds])]
        merged.set(id, { ...ex, ...n, childIds, loaded: ex.loaded || n.loaded })
      } else {
        merged.set(id, n)
      }
      // Ensure parent chain exists
      if (n.parentId && !merged.has(n.parentId)) {
        // parent will be added by its own iteration
      }
    }
    return merged
  }, [aiNodes, explorerNodes])

  // Fetch children from PI API and inject into explorerNodes
  const loadChildren = useCallback(async (node: AFNode) => {
    if (node.loaded || node.type === 'root') return
    setExplorerNodes(prev => {
      const next = new Map(prev)
      const n = next.get(node.id) ?? node
      next.set(node.id, { ...n, loaded: false, state: n.state === 'idle' ? 'querying' : n.state })
      return next
    })
    try {
      const res = await fetch(`/api/pi/children?path=${encodeURIComponent(node.path)}`)
      const data = await res.json() as { children: { name: string; path: string }[] }
      setExplorerNodes(prev => {
        const next = new Map(prev)
        const parentId = node.id
        const newChildIds: string[] = []
        for (const ch of data.children) {
          const segs = ch.path.replace(/\\/g, '/').split('/').filter(Boolean)
          const nid = `n:${segs.join('/')}`
          if (!next.has(nid)) {
            next.set(nid, {
              id: nid, name: ch.name, path: ch.path,
              parentId, childIds: [], type: 'element',
              state: 'idle', toolName: '', queryCount: 0, ts: '',
              loaded: false, collapsed: false,
            } as AFNode)
          }
          if (!newChildIds.includes(nid)) newChildIds.push(nid)
        }
        const parent = next.get(parentId) ?? node
        const merged = [...new Set([...parent.childIds, ...newChildIds])]
        next.set(parentId, { ...parent, childIds: merged, loaded: true, state: 'done' })
        return next
      })
    } catch {
      setExplorerNodes(prev => {
        const next = new Map(prev)
        const n = next.get(node.id) ?? node
        next.set(node.id, { ...n, loaded: true })
        return next
      })
    }
  }, [])

  // Toggle collapse on an already-loaded node
  const collapseNode = useCallback((node: AFNode) => {
    setExplorerNodes(prev => {
      const next = new Map(prev)
      const n = next.get(node.id) ?? node
      next.set(node.id, { ...n, collapsed: !n.collapsed })
      return next
    })
  }, [])

  // Load PI attribute tags for a leaf element node
  const loadTags = useCallback(async (node: AFNode) => {
    if (node.type !== 'element') return
    // Mark as querying
    setExplorerNodes(prev => {
      const next = new Map(prev)
      const n = next.get(node.id) ?? node
      next.set(node.id, { ...n, state: 'querying' })
      return next
    })
    try {
      const res = await fetch(`/api/pi/attributes?path=${encodeURIComponent(node.path)}`)
      const data = await res.json() as { attributes: { name: string; tagName: string; path: string; uom?: string }[] }
      setExplorerNodes(prev => {
        const next = new Map(prev)
        const parentId = node.id
        const newChildIds: string[] = []
        for (const attr of data.attributes) {
          const nid = `tag:${parentId}/${attr.name}`
          if (!next.has(nid)) {
            next.set(nid, {
              id: nid, name: attr.name, path: attr.path || node.path,
              parentId, childIds: [], type: 'tag',
              state: 'done', toolName: '', queryCount: 0, ts: '',
              loaded: true, collapsed: false,
              tagName: attr.tagName, uom: attr.uom,
            } as AFNode)
          }
          if (!newChildIds.includes(nid)) newChildIds.push(nid)
        }
        const parent = next.get(parentId) ?? node
        const merged = [...new Set([...parent.childIds, ...newChildIds])]
        next.set(parentId, { ...parent, childIds: merged, loaded: true, state: 'done' })
        return next
      })
    } catch {
      setExplorerNodes(prev => {
        const next = new Map(prev)
        const n = next.get(node.id) ?? node
        next.set(node.id, { ...n, state: 'done' })
        return next
      })
    }
  }, [])

  // Bootstrap: auto-load root children on mount so tree is browseable from start
  useEffect(() => {
    const boot = async () => {
      try {
        const res = await fetch('/api/pi/children?path=')
        const data = await res.json() as { children: { name: string; path: string }[] }
        setExplorerNodes(prev => {
          const next = new Map(prev)
          const newChildIds: string[] = []
          for (const ch of data.children) {
            const segs = ch.path.replace(/\\/g, '/').split('/').filter(Boolean)
            const nid = `n:${segs.join('/')}`
            if (!next.has(nid)) {
              next.set(nid, {
                id: nid, name: ch.name, path: ch.path,
                parentId: '__root__', childIds: [], type: 'element',
                state: 'idle', toolName: '', queryCount: 0, ts: '',
                loaded: false, collapsed: false,
              } as AFNode)
            }
            if (!newChildIds.includes(nid)) newChildIds.push(nid)
          }
          // Create or update __root__ in explorerNodes with these childIds
          const root = next.get('__root__') ?? {
            id: '__root__', name: 'PI ROOT', path: '',
            parentId: null, childIds: [], type: 'root' as const,
            state: 'done' as const, toolName: '', queryCount: 0, ts: '',
            loaded: true, collapsed: false,
          }
          next.set('__root__', { ...root, childIds: [...new Set([...root.childIds, ...newChildIds])] })
          return next
        })
      } catch { /* server may not be ready yet; AI will populate tree */ }
    }
    // Small delay to let server initialize
    const t = setTimeout(boot, 1500)
    return () => clearTimeout(t)
  }, [])

  // ── Status polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    let prevReady = false

    const poll = async () => {
      try {
        const res  = await fetch('/api/status')
        const data = await res.json() as {
          ready: boolean; error?: string; model?: string
          cache?: { status: string; scan_files?: number }
        }

        const scanFileCount = data.cache?.scan_files ?? 0
        const cacheInfo = scanFileCount > 0
          ? `${scanFileCount} scan${scanFileCount > 1 ? 's' : ''} guardado${scanFileCount > 1 ? 's' : ''}`
          : 'sin scans'

        setStatus(s => {
          const busy = s.state === 'thinking' || s.state === 'executing'
          if (data.ready) {
            return { ...s, state: busy ? s.state : 'ready', label: busy ? s.label : 'CONECTADO', model: data.model ?? '—', cacheInfo, error: undefined }
          }
          if (data.error) {
            return { ...s, state: 'error', label: 'ERROR', error: data.error, model: data.model ?? '—', cacheInfo }
          }
          return { ...s, state: busy ? s.state : 'connecting', label: busy ? s.label : 'INICIANDO…', model: data.model ?? '—', cacheInfo }
        })

        if (data.ready) {
          // Clear any connection-error messages now that server is up
          setMessages(prev => prev.filter(m => m.role !== 'error'))

          if (!prevReady) {
            prevReady = true
            setMessages(prev => prev.map(m =>
              m.id === 'banner'
                ? { ...m, content: m.content.replace('Conectando con Azure AI Foundry…', 'Agente listo.\n\nEjemplos:\n• Enumera las lineas de producción\n• Dame las máquinas de la Linea 1 Left\n• Grafica los datos del tag Squeegee Speed de la Paste Printer en Linea 1 Left del mes de mayo 2026') }
                : m
            ))
            setTimeout(() => inputRef.current?.focus(), 100)
          }
        }

        if (data.error && !prevReady) {
          prevReady = true
          setMessages(prev => {
            if (prev.some(m => m.role === 'error')) return prev
            return [...prev, {
              id: uid(), role: 'error',
              content: `Error de conexión: ${data.error}\n\nVerifica:\n• az login (en terminal fuera de VS Code)\n• Variables en .env: PROJECT_ENDPOINT, MODEL_DEPLOYMENT_NAME`,
              timestamp: now(),
            }]
          })
        }
      } catch { /* server not ready yet */ }
    }

    const iv = setInterval(poll, 2000)
    poll()
    return () => clearInterval(iv)
  }, [])

  // ── Send message ───────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || status.state === 'thinking' || status.state === 'connecting') return

    setInput('')
    setStatus(s => ({ ...s, state: 'thinking', label: 'PENSANDO…' }))
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text, timestamp: now() }])

    const agentId = uid()
    const agentTs = now()
    const messageToSend = ctxNode
      ? ctxNode.type === 'tag'
        ? `[Tag PI seleccionado: "${ctxNode.name}" — Tag name: ${ctxNode.tagName ?? ctxNode.name}${ctxNode.uom ? ' — UOM: ' + ctxNode.uom : ''} — Ruta: ${ctxNode.path}]\n\n${text}`
        : `[Nodo seleccionado en PI AF Tree: "${ctxNode.name}" — Ruta completa: ${ctxNode.path}]\n\n${text}`
      : text

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageToSend }),
      })

      let lastAnswerContent = ''

      for await (const ev of readSSE(res)) {
        const e = ev as { type: string; name?: string; preview?: string; content?: string }

        if (e.type === 'tool_call' || e.type === 'tool_result') {
          setTools(prev => [...prev, {
            id: uid(),
            type: e.type as 'tool_call' | 'tool_result',
            name: e.name ?? '',
            preview: e.preview ?? '',
            timestamp: now(),
          }])
        } else if (e.type === 'answer') {
          const content = e.content ?? ''
          lastAnswerContent = content
          setMessages(prev => {
            const exists = prev.find(m => m.id === agentId)
            if (exists) return prev.map(m => m.id === agentId ? { ...m, content } : m)
            return [...prev, { id: agentId, role: 'agent', content, timestamp: agentTs }]
          })
        } else if (e.type === 'error') {
          setMessages(prev => [...prev, { id: uid(), role: 'error', content: e.content ?? 'Error desconocido', timestamp: now() }])
        }
      }

      // Auto-ejecutar código matplotlib sin requerir click manual
      const codeToRun = extractLastCode(lastAnswerContent)
      if (codeToRun && (codeToRun.includes('plt.') || codeToRun.includes('import matplotlib'))) {
        await executeCode(codeToRun)
      }
    } catch (err) {
      setMessages(prev => [...prev, { id: uid(), role: 'error', content: String(err), timestamp: now() }])
    }

    setStatus(s => ({ ...s, state: 'ready', label: 'CONECTADO' }))
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [input, status.state])

  // ── Execute Python ─────────────────────────────────────────────────────────
  const executeCode = useCallback(async (code: string) => {
    setStatus(s => ({ ...s, state: 'executing', label: 'EJECUTANDO…' }))
    setTools(prev => [...prev, { id: uid(), type: 'tool_call', name: 'execute_python', preview: code.slice(0, 80) + '…', timestamp: now() }])

    try {
      const res  = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json() as { stdout?: string; stderr?: string; returncode?: number; plot_base64?: string }

      setTools(prev => [...prev, {
        id: uid(), type: 'tool_result', name: 'execute_python',
        preview: (data.returncode === 0 ? 'OK' : `Error ${data.returncode}`) + (data.stdout ? ' · ' + data.stdout.slice(0, 60) : ''),
        timestamp: now(),
      }])

      if (data.plot_base64) {
        const plotUrl = `data:image/png;base64,${data.plot_base64}`
        // Attach plot to the last agent message that had code
        setMessages(prev => {
          const idx = [...prev].reverse().findIndex(m => m.role === 'agent' && extractLastCode(m.content))
          if (idx === -1) return prev
          const realIdx = prev.length - 1 - idx
          return prev.map((m, i) => i === realIdx ? { ...m, plotUrl } : m)
        })
      } else if (data.stdout) {
        setMessages(prev => [...prev, { id: uid(), role: 'system', content: `Output:\n${data.stdout}`, timestamp: now() }])
      }
      if (data.stderr && data.returncode !== 0) {
        setMessages(prev => [...prev, { id: uid(), role: 'error', content: `Error en código:\n${data.stderr}`, timestamp: now() }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { id: uid(), role: 'error', content: String(err), timestamp: now() }])
    }

    setStatus(s => ({ ...s, state: 'ready', label: 'CONECTADO' }))
  }, [])

  // ── Plant Health Scan ──────────────────────────────────────────────
  const runHealthScan = useCallback(async (plan: string = '', fromDt: string = '', toDt: string = '') => {
    if (scanState.phase === 'running') return
    setActivePlan(plan)
    setScanState({ phase: 'running', pct: 0, log: [], summary: null, error: null })
    setScanOpen(true)
    try {
      const res = await fetch('/api/health-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, from_dt: fromDt, to_dt: toDt }),
      })
      for await (const ev of readSSE(res)) {
        const e = ev as Record<string, unknown>
        if (e.type === 'progress') {
          setScanState(s => ({
            ...s,
            pct: (e.pct as number) ?? s.pct,
            log: [...s.log, { msg: e.msg as string, pct: e.pct as number | undefined }],
          }))
        } else if (e.type === 'scan_done') {
          const summary = e.summary as ScanDone
          const prompt = e.prompt as string
          setScanState(s => ({ ...s, phase: 'done', pct: 100, summary }))
          // Enviar prompt al agente automáticamente
          setMessages(prev => [...prev, {
            id: uid(), role: 'system',
            content: `✅ Plant Health Scan completado\n• ${summary.lines} líneas • ${summary.machines} máquinas • ${summary.tags} tags${plan.trim() ? `\n🎯 Plan: ${plan.trim().slice(0, 80)}${plan.length > 80 ? '…' : ''}` : ''}\nAnalizando resultados con la IA…`,
            timestamp: now(),
          }])
          // Mandar el prompt al agente directamente vía sendMessage logic
          setInput(prompt)
          setTimeout(() => {
            setInput('')
            setStatus(s => ({ ...s, state: 'thinking', label: 'ANALIZANDO PLANTA…' }))
            setMessages(prev => [...prev, { id: uid(), role: 'user', content: '(Plant Health Scan — análisis automático)', timestamp: now() }])
            const agentId = uid()
            const agentTs = now()
            fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: prompt }),
            }).then(async chatRes => {
              let lastContent = ''
              for await (const cev of readSSE(chatRes)) {
                const ce = cev as { type: string; content?: string; name?: string; preview?: string }
                if (ce.type === 'tool_call' || ce.type === 'tool_result') {
                  setTools(prev => [...prev, { id: uid(), type: ce.type as 'tool_call'|'tool_result', name: ce.name ?? '', preview: ce.preview ?? '', timestamp: now() }])
                } else if (ce.type === 'answer') {
                  lastContent = ce.content ?? ''
                  setMessages(prev => {
                    const exists = prev.find(m => m.id === agentId)
                    if (exists) return prev.map(m => m.id === agentId ? { ...m, content: lastContent } : m)
                    return [...prev, { id: agentId, role: 'agent', content: lastContent, timestamp: agentTs }]
                  })
                } else if (ce.type === 'error') {
                  setMessages(prev => [...prev, { id: uid(), role: 'error', content: ce.content ?? 'Error', timestamp: now() }])
                }
              }
              setStatus(s => ({ ...s, state: 'ready', label: 'CONECTADO' }))
            }).catch(err => {
              setMessages(prev => [...prev, { id: uid(), role: 'error', content: String(err), timestamp: now() }])
              setStatus(s => ({ ...s, state: 'ready', label: 'CONECTADO' }))
            })
          }, 200)
        } else if (e.type === 'scan_error') {
          setScanState(s => ({ ...s, phase: 'error', error: e.msg as string }))
        }
      }
    } catch (err) {
      setScanState(s => ({ ...s, phase: 'error', error: String(err) }))
    }
  }, [scanState.phase])

  // ── Cache refresh (elimina archivos health_scan_*.json) ──────────────────
  const [cleaning, setCleaning] = useState(false)

  const refreshCache = async () => {
    if (cleaning) return
    const countMatch = status.cacheInfo.match(/^(\d+)/)
    const scanCount = countMatch ? parseInt(countMatch[1]) : 0
    const confirmMsg = scanCount > 0
      ? `¿Eliminar ${scanCount} archivo${scanCount > 1 ? 's' : ''} de escaneo? Esta acción no se puede deshacer.`
      : '¿Limpiar archivos de escaneo guardados?'
    if (!window.confirm(confirmMsg)) return

    setCleaning(true)
    try {
      const res = await fetch('/api/cache/refresh', { method: 'POST' })
      const data = await res.json() as { deleted: number; errors: string[] }
      const msg = data.deleted > 0
        ? `✔ ${data.deleted} eliminado${data.deleted > 1 ? 's' : ''}`
        : 'sin scans'
      setStatus(s => ({ ...s, cacheInfo: msg }))
      // Cerrar tabla si estaba abierta — los scans ya no existen
      setTableOpen(false)
      setScanState(s => ({ ...s, phase: 'idle', summary: null }))
    } catch {
      setStatus(s => ({ ...s, cacheInfo: 'error al eliminar' }))
    } finally {
      setCleaning(false)
    }
  }

  // ── Key handler ────────────────────────────────────────────────────────────
  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  // ── Status color ───────────────────────────────────────────────────────────
  const stateColor: Record<AppState, string> = {
    connecting: '#ffa500',
    ready:      '#00ff41',
    error:      '#ff4444',
    thinking:   '#ffff00',
    executing:  '#00c8ff',
  }
  const col = stateColor[status.state]

  const busy = status.state === 'thinking' || status.state === 'connecting' || status.state === 'executing'

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={`app${lightMode ? ' light' : ''}`}>
      {/* Status Bar */}
      <div className="status-bar">
        <span className="status-brand">⬡ KEMEX DATA SCIENCE </span>
        <span className="status-sep">│</span>
        <span className="status-dot" style={{ color: col }}>■</span>
        <span className="status-label" style={{ color: col }}>{status.label}</span>
        <span className="status-sep">│</span>
        <span className="status-dim">MODELO</span>
        <span className="status-val">{status.model}</span>
        <span className="status-sep">│</span>
        <span className="status-dim">{status.cacheInfo}</span>
        <button
          className={`hscan-btn${scanState.phase === 'running' ? ' hscan-btn-active' : ''}`}
          onClick={() => {
            if (scanState.phase === 'running') { setScanOpen(true); return }
            setPlanOpen(true)
          }}
          title={activePlan ? `Plan activo: ${activePlan.slice(0, 60)}…` : 'Plant Health Scan — análisis de toda la planta'}>
          {scanState.phase === 'running'
            ? `▶ SCAN ${scanState.pct.toFixed(0)}%`
            : scanState.phase === 'done' ? (activePlan ? '🎯 SCAN' : '✔ SCAN')
            : '⬡ SCAN'}
        </button>
        {(scanState.phase === 'done') && (
          <button
            className="dt-open-btn"
            onClick={() => setTableOpen(true)}
            title="Ver datos del último escaneo">
            📊 DATOS
          </button>
        )}
        <button className="theme-btn" onClick={() => setLightMode(l => !l)} title="Cambiar tema">
          {lightMode ? '◑ DARK' : '○ LIGHT'}
        </button>
        <button className="docs-btn" onClick={() => setDocsOpen(true)} title="Documentación y guía de uso">
          📖 DOCS
        </button>
        <button
          className={`cache-btn${cleaning ? ' cache-btn-cleaning' : ''}`}
          onClick={refreshCache}
          disabled={cleaning}
          title="Eliminar archivos de escaneo guardados (health_scan_*.json)">
          {cleaning ? '⟳ LIMPIANDO…' : '🗑 LIMPIAR'}
        </button>
      </div>

      {/* Main split */}
      <div className="main">
        {/* Chat */}
        <div className="chat-panel">
          <div className="chat-log" ref={chatLogRef} onScroll={handleChatScroll}>
            {messages.map(m => (
              <MessageBubble
                key={m.id}
                msg={m}
                onExecute={m.role === 'agent' ? executeCode : undefined}
                onZoom={setZoomedPlot}
              />
            ))}
            <div ref={chatEndRef} />
          </div>
          {!atBottom && (
            <button
              className="scroll-to-bottom-btn"
              onClick={() => { setAtBottom(true); chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }}
              title="Ir al final del chat"
            >
              ↓
            </button>
          )}
        </div>

        {/* Tool Activity */}
        <PiTreePanel
          nodes={afNodes}
          tools={tools}
          toolsOpen={toolsOpen}
          onToggle={() => setToolsOpen(o => !o)}
          selectedId={ctxNode?.id ?? null}
          onSelect={n => setCtxNode(prev => prev?.id === n.id ? null : n)}
          onExpandNode={loadChildren}
          onCollapseNode={collapseNode}
          onLoadTags={loadTags}
        />
      </div>

      {/* AI Pet + Input */}
      <div className="input-zone">
        <AIPet state={status.state} lightMode={lightMode} />
        {/* Context node pill */}
        {ctxNode && (
          <div className="ctx-pill-row">
            <button className="ctx-pill" onClick={() => setCtxNode(null)}
              title="Clic para deseleccionar">
              <span className="ctx-pill-plus">+</span>
              <span className="ctx-pill-label">{nodeDisplayLabel(ctxNode)}</span>
              <span className="ctx-pill-x">×</span>
            </button>
          </div>
        )}
        {/* Input */}
        <div className="input-row">
          <span className="prompt-glyph">❯</span>
        <input
          ref={inputRef}
          className="user-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={busy ? 'Procesando…' : 'Escribe tu pregunta aquí…'}
          disabled={busy}
        />
        <button className="send-btn" onClick={sendMessage} disabled={busy || !input.trim()}>
          ENVIAR
        </button>
        </div>
      </div>

      {/* Plan Modal */}
      {planOpen && (
        <PlanModal
          onStart={(plan, fromDt, toDt) => { setPlanOpen(false); runHealthScan(plan, fromDt, toDt) }}
          onCancel={() => setPlanOpen(false)}
        />
      )}

      {/* Health Scan Panel */}
      {scanOpen && (
        <HealthScanPanel scan={scanState} onClose={() => setScanOpen(false)} />
      )}

      {/* Scan Data Table */}
      {tableOpen && (
        <ScanDataTable onClose={() => setTableOpen(false)} />
      )}

      {/* Docs Modal */}
      {docsOpen && (
        <DocsModal onClose={() => setDocsOpen(false)} />
      )}

      {/* Lightbox */}
      {zoomedPlot && (
        <div className="lightbox" onClick={() => setZoomedPlot(null)}>
          <button className="lightbox-close" onClick={e => { e.stopPropagation(); setZoomedPlot(null) }}>✕ CERRAR</button>
          <img
            src={zoomedPlot}
            alt="Gráfica"
            className="lightbox-img"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
