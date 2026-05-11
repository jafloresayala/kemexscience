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

// ─── Node Tree Item ───────────────────────────────────────────────────────────
function NodeTreeItem({ nodeId, nodes, isLastStack, relatedIds, onHover, onFocus }: {
  nodeId: string; nodes: Map<string, AFNode>; isLastStack: boolean[]
  relatedIds: Set<string>; onHover: (id: string | null) => void; onFocus: (id: string) => void
}) {
  const node = nodes.get(nodeId)
  if (!node) return null
  const depth = isLastStack.length
  const isLast = depth === 0 || isLastStack[depth - 1]
  const lit = relatedIds.has(nodeId)

  let indent = ''
  for (let i = 0; i < depth - 1; i++) indent += isLastStack[i] ? '    ' : '│   '
  if (depth > 0) indent += isLast ? '└── ' : '├── '

  const stateIcon = node.state === 'querying' ? '⬡'
    : node.type === 'root' ? '◉'
    : node.state === 'done' ? '◈' : '○'

  const toolShort: Record<string, string> = {
    pi_fetch_child_elements: 'CHILDREN',
    pi_fetch_element_attributes: 'ATTRS',
    pi_fetch_tag_values: 'VALUES',
    pi_get_tag_snapshot: 'SNAP',
  }

  return (
    <div className="tni-group">
      <div
        className={`tni tni-${node.state}${lit ? ' tni-lit' : ''}${node.type === 'root' ? ' tni-root' : ''}`}
        style={node.childIds.length > 0 ? { cursor: 'pointer' } : undefined}
        onMouseEnter={() => onHover(nodeId)}
        onMouseLeave={() => onHover(null)}
        onClick={() => node.childIds.length > 0 && onFocus(nodeId)}
        title={`${node.path || 'PI Root'} · ${node.queryCount} consulta(s)`}
      >
        <span className="tni-indent">{indent}</span>
        <span className={`tni-icon tni-icon-${node.state}`}>{stateIcon}</span>
        <span className="tni-name">{node.name}</span>
        {node.state === 'querying' && <span className="tni-badge tni-badge-querying">▶ QUERYING</span>}
        {node.state === 'done' && node.queryCount > 0 && (
          <span className="tni-badge tni-badge-done">{toolShort[node.toolName] ?? '✓'}</span>
        )}
        {node.childIds.length > 0 && node.state !== 'querying' && <span className="tni-chevron">›</span>}
      </div>
      {node.childIds.map((cid, i) => (
        <NodeTreeItem key={cid} nodeId={cid} nodes={nodes}
          isLastStack={[...isLastStack, i === node.childIds.length - 1]}
          relatedIds={relatedIds} onHover={onHover} onFocus={onFocus} />
      ))}
    </div>
  )
}

// ─── PI Tree Panel ────────────────────────────────────────────────────────────
function PiTreePanel({ nodes, tools, toolsOpen, onToggle }: {
  nodes: Map<string, AFNode>; tools: ToolEvent[]
  toolsOpen: boolean; onToggle: () => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState('__root__')
  const evEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { evEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [tools])

  const focusedNode = nodes.get(focusedId) ?? nodes.get('__root__')
  const relatedIds = hoveredId ? getRelatedIds(nodes, hoveredId) : new Set<string>()
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

      {/* Tree */}
      <div className="pi-tree-body">
        {hasTree && focusedNode ? (
          <NodeTreeItem
            nodeId={focusedNode.id} nodes={nodes} isLastStack={[]}
            relatedIds={relatedIds}
            onHover={setHoveredId}
            onFocus={id => { setFocusedId(id); setHoveredId(null) }}
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
