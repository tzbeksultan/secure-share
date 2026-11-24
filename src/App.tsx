import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Check, Clock3, Copy, FileImage, FileText, KeyRound, Link2, LockKeyhole, ShieldCheck, Sparkles, Upload, X } from 'lucide-react'

type Expiry = 300 | 3600 | 86400
type Payload = { kind: 'text'; text: string } | { kind: 'file'; name: string; mime: string; data: string }

const MAX_FILE_BYTES = 10 * 1024 * 1024
const expiryLabels: Record<Expiry, string> = { 300: '5 минут', 3600: '1 час', 86400: '24 часа' }

function toBase64(bytes: Uint8Array) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}
function fromBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
async function encryptPayload(payload: Payload) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  const rawKey = await crypto.subtle.exportKey('raw', key)
  return { ciphertext: toBase64(new Uint8Array([...iv, ...new Uint8Array(encrypted)])), key: toBase64(new Uint8Array(rawKey)) }
}
async function decryptPayload(ciphertext: string, rawKey: string): Promise<Payload> {
  const bytes = fromBase64(ciphertext)
  if (bytes.length < 29) throw new Error('Повреждённые данные')
  const key = await crypto.subtle.importKey('raw', fromBase64(rawKey), { name: 'AES-GCM' }, false, ['decrypt'])
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
  return JSON.parse(new TextDecoder().decode(decrypted)) as Payload
}
function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

export default function App() {
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [expiry, setExpiry] = useState<Expiry>(3600)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [received, setReceived] = useState<Payload | null>(null)
  const [receivedError, setReceivedError] = useState('')
  const [loadingReceived, setLoadingReceived] = useState(false)
  const [blurred, setBlurred] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const hash = window.location.hash
  const isViewer = window.location.pathname.startsWith('/s/')

  useEffect(() => {
    const onBlur = () => setBlurred(true)
    const onFocus = () => setBlurred(false)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!isViewer) return
    const id = window.location.pathname.split('/').pop()
    const key = new URLSearchParams(hash.slice(1)).get('key')
    if (!id || !key) {
      setReceivedError('Ссылка неполная: отсутствует ключ шифрования.')
      return
    }
    setLoadingReceived(true)
    // Remove key from visible address bar after capturing it in memory.
    window.history.replaceState(null, '', window.location.pathname)
    fetch(`/api/shares/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Ссылка уже открыта, истекла или не существует.')
        const body = await response.json() as { ciphertext: string }
        return decryptPayload(body.ciphertext, key)
      })
      .then(setReceived)
      .catch(err => setReceivedError(err instanceof Error ? err.message : 'Не удалось открыть секрет.'))
      .finally(() => setLoadingReceived(false))
  }, [isViewer, hash])

  async function createShare() {
    setError('')
    setShareUrl('')
    if (!text.trim() && !file) {
      setError('Добавь текст или выбери файл.')
      return
    }
    setBusy(true)
    try {
      let payload: Payload
      if (file) {
        if (file.size > MAX_FILE_BYTES) throw new Error('Максимальный размер файла — 10 МБ.')
        const data = toBase64(new Uint8Array(await file.arrayBuffer()))
        payload = { kind: 'file', name: file.name, mime: file.type || 'application/octet-stream', data }
      } else {
        payload = { kind: 'text', text }
      }
      const encrypted = await encryptPayload(payload)
      const response = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ciphertext: encrypted.ciphertext,
          expiresInSeconds: expiry,
          fileName: file?.name ?? '',
          mimeType: file?.type ?? '',
        }),
      })
      const result = await response.json() as { id?: string; error?: string }
      if (!response.ok || !result.id) throw new Error(result.error || 'Не удалось создать ссылку.')
      const url = new URL(`/s/${result.id}`, window.location.origin)
      url.hash = new URLSearchParams({ key: encrypted.key }).toString()
      setShareUrl(url.toString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Что-то пошло не так.')
    } finally {
      setBusy(false)
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  function downloadFile(payload: Extract<Payload, { kind: 'file' }>) {
    const blob = new Blob([fromBase64(payload.data)], { type: payload.mime || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = payload.name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (isViewer) {
    return <main className="shell viewer-shell">
      <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><LockKeyhole size={18}/></span> secure<span>share</span></a><span className="secure-label"><ShieldCheck size={14}/> Зашифровано</span></header>
      <section className="viewer-card">
        <div className="eyebrow"><span className="pulse"/> ПРИВАТНЫЙ ПРОСМОТР</div>
        {loadingReceived ? <div className="empty-state"><div className="spinner"/><h2>Открываем секрет…</h2><p>Проверяем одноразовую ссылку и расшифровываем данные в браузере.</p></div> :
          receivedError ? <div className="empty-state"><div className="large-icon"><X size={24}/></div><h2>Не удалось открыть</h2><p>{receivedError}</p><a className="button secondary" href="/">На главную</a></div> :
          received ? <div className={blurred ? 'secret-content obscured' : 'secret-content'}>
            <div className="large-icon"><ShieldCheck size={25}/></div>
            <h1>Секрет открыт</h1>
            <p className="muted">Эта ссылка уже использована и повторно не откроется.</p>
            {received.kind === 'text' ? <pre className="secret-text">{received.text}</pre> :
              <div className="file-result"><FileText size={22}/><div><strong>{received.name}</strong><small>Файл расшифрован в браузере</small></div><button className="button primary" onClick={() => downloadFile(received)}><ArrowDownToLine size={16}/> Скачать</button></div>}
            <div className="notice"><ShieldCheck size={16}/> Не пересылайте содержимое посторонним. Скриншоты невозможно полностью запретить в браузере.</div>
          </div> : null}
      </section>
      <footer className="footer">Secure Share · Секреты не хранятся в открытом виде на сервере</footer>
    </main>
  }

  return <main className="shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><LockKeyhole size={18}/></span> secure<span>share</span></a><span className="secure-label"><ShieldCheck size={14}/> End-to-end encryption</span></header>
    <section className="hero">
      <div className="eyebrow"><Sparkles size={14}/> ПЕРЕДАЧА БЕЗ ЛИШНИХ СЛЕДОВ</div>
      <h1>Поделись секретом.<br/><span>Не оставляй его навсегда.</span></h1>
      <p>Зашифруй сообщение или файл прямо в браузере и отправь одноразовую ссылку. Ключ шифрования не передаётся серверу.</p>
    </section>
    <section className="composer">
      <div className="composer-head"><div><LockKeyhole size={17}/><strong>Новое защищённое сообщение</strong></div><span className="tag">AES-256-GCM</span></div>
      <label className="field-label" htmlFor="secret-text">Текст или пароль</label>
      <textarea id="secret-text" value={text} onChange={e => { setText(e.target.value); if (e.target.value) setFile(null) }} placeholder="Вставь сюда пароль, сообщение или другую информацию…" rows={6}/>
      <div className="or-divider"><span>ИЛИ ПРИКРЕПИ ФАЙЛ</span></div>
      <input ref={fileRef} className="hidden-input" type="file" onChange={e => { const selected = e.target.files?.[0] ?? null; setFile(selected); if (selected) setText('') }}/>
      <button className={file ? 'upload-zone selected' : 'upload-zone'} onClick={() => fileRef.current?.click()}>
        {file ? <><FileImage size={22}/><span><strong>{file.name}</strong><small>{formatSize(file.size)} · Нажми, чтобы заменить</small></span><X size={17} onClick={e => { e.stopPropagation(); setFile(null); if (fileRef.current) fileRef.current.value = '' }}/></> : <><Upload size={22}/><span><strong>Выбрать файл</strong><small>Фото, PDF или документ · до 10 МБ</small></span></>}
      </button>
      <div className="settings-row"><div><Clock3 size={16}/><span>Ссылка действует</span></div><select value={expiry} onChange={e => setExpiry(Number(e.target.value) as Expiry)}>{Object.entries(expiryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      {error && <div className="error">{error}</div>}
      <button className="button primary create-button" disabled={busy || (!text.trim() && !file)} onClick={createShare}>{busy ? <><span className="spinner small"/> Шифруем…</> : <><LockKeyhole size={17}/> Создать защищённую ссылку</>}</button>
      {shareUrl && <div className="share-result"><div className="success-title"><Check size={17}/> Ссылка готова. Ключ находится внутри неё.</div><div className="link-copy"><input readOnly value={shareUrl}/><button onClick={copyLink} aria-label="Скопировать ссылку">{copied ? <Check size={18}/> : <Copy size={18}/>}</button></div><p>Отправь ссылку получателю через другой канал. После первого открытия она станет недействительной.</p></div>}
    </section>
    <section className="features"><div><span><KeyRound size={18}/></span><strong>Шифрование в браузере</strong><small>Сервер получает только шифротекст.</small></div><div><span><Clock3 size={18}/></span><strong>Временная ссылка</strong><small>Автоматическое истечение по таймеру.</small></div><div><span><ShieldCheck size={18}/></span><strong>Одноразовый доступ</strong><small>Первое открытие забирает секрет.</small></div></section>
    <div className="disclaimer"><ShieldCheck size={15}/> Экспериментальный MVP. Не используй для банковских, клиентских или иных критичных секретов до независимого аудита. Блокировка скриншотов в браузере не гарантируется.</div>
    <footer className="footer">Сделано с заботой о приватности · Secure Share v0.1</footer>
  </main>
}
