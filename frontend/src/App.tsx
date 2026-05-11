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
  type: 'root' | 'element'
  state: 'idle' | 'querying' | 'done'
  toolName: string; queryCount: number; ts: string
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
    state: 'idle', toolName: '', queryCount: 0, ts: '',
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
    if (node.childIds.length === 0) {
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
function PiNodeGraph({
  nodes, focusedId, onFocus,
}: {
  nodes: Map<string, AFNode>
  focusedId: string
  onFocus: (id: string) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const positions = useMemo(
    () => computeLayout(focusedId, nodes),
    [focusedId, nodes],
  )

  const relatedIds = useMemo(
    () => hoveredId ? getRelatedIds(nodes, hoveredId) : new Set<string>(),
    [hoveredId, nodes],
  )

  if (positions.size === 0) return null

  const allPos = [...positions.values()]
  const xs = allPos.map(p => p.x)
  const ys = allPos.map(p => p.y)
  const PAD = 52
  const vx = Math.min(...xs) - PAD
  const vy = Math.min(...ys) - PAD
  const vw = Math.max(...xs) - vx + PAD
  const vh = Math.max(...ys) - vy + PAD + 28

  const stateCol = (n: AFNode, lit: boolean) => {
    if (lit)                              return '#00c8ff'
    if (n.state === 'querying')           return '#ffb700'
    if (n.type === 'root')                return '#00c8ff'
    if (n.state === 'done' && n.queryCount > 0) return '#00ff41'
    return '#2a4060'
  }

  return (
    <svg
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      style={{ width: '100%', height: '100%', display: 'block', minHeight: 120 }}
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
        const querying = node.state === 'querying'
        const isRoot = node.type === 'root'
        const R = isRoot ? 24 : 19
        const canDrill = node.childIds.length > 0
        const shortName = node.name.length > 13 ? node.name.slice(0, 12) + '…' : node.name

        return (
          <g
            key={id}
            transform={`translate(${p.x},${p.y})`}
            style={{ cursor: canDrill ? 'pointer' : 'default' }}
            onMouseEnter={() => setHoveredId(id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => canDrill && onFocus(id)}
          >
            {/* Expanding pulse ring for querying */}
            {querying && (
              <circle r={R + 9} fill="none" stroke="#ffb700" strokeWidth="1.2"
                opacity="0.5" className="svg-pulse-ring" />
            )}
            {/* Glow halo when lit or querying */}
            {(lit || querying) && (
              <circle r={R + 5}
                fill={querying ? 'rgba(255,183,0,0.07)' : 'rgba(0,200,255,0.07)'}
                stroke={querying ? 'rgba(255,183,0,0.35)' : 'rgba(0,200,255,0.35)'}
                strokeWidth="1"
                filter={`url(#glow${querying ? 'Y' : 'C'})`}
              />
            )}
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
            {/* Label */}
            <text y={R + 13} textAnchor="middle" fontSize="8.5"
              fontFamily="'JetBrains Mono', monospace" letterSpacing="0.02em"
              fill={lit ? '#00c8ff' : querying ? '#ffb700' : '#4a6880'}>
              {shortName}
            </text>
            {/* Drill hint */}
            {canDrill && (
              <text y={R + 23} textAnchor="middle" fontSize="7.5" fontFamily="monospace"
                fill={lit ? 'rgba(0,200,255,0.65)' : 'rgba(0,200,255,0.22)'}>
                {node.childIds.length} ›
              </text>
            )}
            {/* Query count badge */}
            {node.queryCount > 0 && !querying && (
              <g transform={`translate(${R - 3},${-R + 3})`}>
                <circle r="6" fill="#001510" stroke="#00ff41" strokeWidth="0.9" />
                <text textAnchor="middle" dominantBaseline="central"
                  fontSize="6.5" fill="#00ff41" fontFamily="monospace">
                  {node.queryCount}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ─── PI Tree Panel ────────────────────────────────────────────────────────────
function PiTreePanel({ nodes, tools, toolsOpen, onToggle }: {
  nodes: Map<string, AFNode>; tools: ToolEvent[]
  toolsOpen: boolean; onToggle: () => void
}) {
  const [focusedId, setFocusedId] = useState('__root__')
  const evEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { evEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [tools])
  useEffect(() => { if (!nodes.has(focusedId)) setFocusedId('__root__') }, [nodes, focusedId])

  const focusedNode = nodes.get(focusedId) ?? nodes.get('__root__')
  const hasTree = nodes.size > 1
  const queryingCount = [...nodes.values()].filter(n => n.state === 'querying').length

  const breadcrumb: AFNode[] = []
  let cur: AFNode | undefined = focusedNode
  while (cur) { breadcrumb.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : undefined }

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
    <div className="tool-panel">
      {/* Header */}
      <div className="pi-hdr">
        <span className="pi-hdr-logo">⬡</span>
        <span className="pi-hdr-title">PI AF TREE</span>
        <div className="pi-hdr-actions">
          {focusedId !== '__root__' && (
            <button className="pi-hdr-btn" onClick={() =>
              setFocusedId(nodes.get(focusedId)?.parentId ?? '__root__')
            } title="Subir nivel">↑</button>
          )}
          <button className="pi-hdr-btn" onClick={onToggle} title="Colapsar">▶</button>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="pi-crumb">
        {breadcrumb.map((n, i) => (
          <span key={n.id}>
            {i > 0 && <span className="pi-crumb-sep"> › </span>}
            <span
              className={`pi-crumb-item${n.id === focusedNode?.id ? ' pi-crumb-active' : ''}`}
              onClick={() => setFocusedId(n.id)}
            >{n.name}</span>
          </span>
        ))}
      </div>

      {/* SVG Graph */}
      <div className="pi-graph-body">
        {hasTree ? (
          <PiNodeGraph
            nodes={nodes}
            focusedId={focusedId}
            onFocus={setFocusedId}
          />
        ) : (
          <div className="pi-empty">
            <div className="pi-empty-icon">◌</div>
            <div>Sin consultas activas</div>
            <div>La IA navegará el árbol AF aquí</div>
          </div>
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
  const inputRef    = useRef<HTMLInputElement>(null)

  const [toolsOpen, setToolsOpen] = useState(true)
  const [lightMode, setLightMode] = useState(false)
  const [zoomedPlot, setZoomedPlot] = useState<string | null>(null)
  const [scanState, setScanState] = useState<ScanState>({
    phase: 'idle', pct: 0, log: [], summary: null, error: null,
  })
  const [scanOpen, setScanOpen] = useState(false)

  // ── Escape key closes lightbox ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setZoomedPlot(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  const afNodes = useMemo(() => buildAfTree(tools), [tools])

  // ── Status polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    let prevReady = false

    const poll = async () => {
      try {
        const res  = await fetch('/api/status')
        const data = await res.json() as {
          ready: boolean; error?: string; model?: string
          cache?: { status: string; elements?: number }
        }

        const cacheInfo = data.cache?.status === 'ready'
          ? `cache: ${data.cache.elements ?? 0} elementos`
          : `cache: ${data.cache?.status ?? '—'}`

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

        if (data.ready && !prevReady) {
          prevReady = true
          setMessages(prev => prev.map(m =>
            m.id === 'banner'
              ? { ...m, content: m.content.replace('Conectando con Azure AI Foundry…', 'Agente listo.\n\nEjemplos:\n• Enumera las lineas de producción\n• Dame las máquinas de la Linea 1 Left\n• Grafica los datos del tag Squeegee Speed de la Paste Printer en Linea 1 Left del mes de mayo 2026') }
              : m
          ))
          setTimeout(() => inputRef.current?.focus(), 100)
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

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
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
  const runHealthScan = useCallback(async () => {
    if (scanState.phase === 'running') return
    setScanState({ phase: 'running', pct: 0, log: [], summary: null, error: null })
    setScanOpen(true)
    try {
      const res = await fetch('/api/health-scan', { method: 'POST' })
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
            content: `✅ Plant Health Scan completado\n• ${summary.lines} líneas • ${summary.machines} máquinas • ${summary.tags} tags\nAnalizando resultados con la IA…`,
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

  // ── Cache refresh ──────────────────────────────────────────────────────────
  const refreshCache = async () => {
    await fetch('/api/cache/refresh', { method: 'POST' })
    setStatus(s => ({ ...s, cacheInfo: 'cache: construyendo…' }))
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
          onClick={() => scanState.phase === 'idle' || scanState.phase === 'done' || scanState.phase === 'error'
            ? runHealthScan()
            : setScanOpen(true)
          }
          title="Plant Health Scan — análisis de toda la planta">
          {scanState.phase === 'running'
            ? `▶ SCAN ${scanState.pct.toFixed(0)}%`
            : scanState.phase === 'done' ? '✔ SCAN'
            : '⬡ SCAN'}
        </button>
        <button className="theme-btn" onClick={() => setLightMode(l => !l)} title="Cambiar tema">
          {lightMode ? '◑ DARK' : '○ LIGHT'}
        </button>
        <button className="cache-btn" onClick={refreshCache} title="Reconstruir caché del árbol AF">↺ CACHE</button>
      </div>

      {/* Main split */}
      <div className="main">
        {/* Chat */}
        <div className="chat-panel">
          <div className="chat-log">
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
        </div>

        {/* Tool Activity */}
        <PiTreePanel
          nodes={afNodes}
          tools={tools}
          toolsOpen={toolsOpen}
          onToggle={() => setToolsOpen(o => !o)}
        />
      </div>

      {/* AI Pet + Input */}
      <div className="input-zone">
        <AIPet state={status.state} lightMode={lightMode} />
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

      {/* Health Scan Panel */}
      {scanOpen && (
        <HealthScanPanel scan={scanState} onClose={() => setScanOpen(false)} />
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
