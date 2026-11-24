import { useEffect, useRef, useState } from 'react';

const API = (import.meta as any).env.VITE_API_URL?.replace(/\/$/, '') || '';
const BASE = (import.meta as any).env.BASE_URL || '/';
const enc = new TextEncoder();
const MAX_FILE_BYTES = 8 * 1024 * 1024;

type Payload =
  | { kind: 'text'; text: string }
  | { kind: 'file'; name: string; mime: string; data: string; delivery: 'download' | 'view' };

const b64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
};
const randomSecret = () => b64(crypto.getRandomValues(new Uint8Array(32)));

async function encrypt(value: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', unb64(secret), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(value));
  return b64(new Uint8Array([...iv, ...new Uint8Array(data)]));
}

async function decrypt(value: string, secret: string) {
  const bytes = unb64(value);
  const key = await crypto.subtle.importKey('raw', unb64(secret), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new TextDecoder().decode(plain);
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export default function App() {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileDelivery, setFileDelivery] = useState<'download' | 'view'>('download');
  const [previewUrl, setPreviewUrl] = useState('');
  const [protectedHidden, setProtectedHidden] = useState(false);
  const [pin, setPin] = useState('');
  const [ttl, setTtl] = useState('1440');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const [content, setContent] = useState<Payload | null>(null);
  const [viewPin, setViewPin] = useState('');
  const [shareId, setShareId] = useState('');
  const [secret, setSecret] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const prefix = BASE + 's/';
    if (location.pathname.startsWith(prefix)) {
      setShareId(location.pathname.slice(prefix.length).split('/')[0]);
      const parts = location.hash.slice(1).split('.');
      setSecret(parts[0] || '');
      setAccessToken(parts[1] || '');
    }
  }, []);

  const isViewer = Boolean(shareId);

  // Best-effort privacy shield: conceal the rendered secret when the tab/app loses visibility.
  useEffect(() => {
    if (!opened) return;
    const conceal = () => setProtectedHidden(true);
    const reveal = () => setProtectedHidden(false);
    const onVisibility = () => document.visibilityState === 'hidden' ? conceal() : reveal();
    window.addEventListener('blur', conceal);
    window.addEventListener('focus', reveal);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', conceal);
    window.addEventListener('pageshow', reveal);
    return () => {
      window.removeEventListener('blur', conceal);
      window.removeEventListener('focus', reveal);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', conceal);
      window.removeEventListener('pageshow', reveal);
    };
  }, [opened]);

  useEffect(() => {
    if (!opened || !content || content.kind !== 'file' || content.delivery !== 'view') return;
    const block = (event: Event) => event.preventDefault();
    document.addEventListener('contextmenu', block);
    document.addEventListener('selectstart', block);
    document.addEventListener('dragstart', block);
    document.addEventListener('copy', block);
    document.addEventListener('cut', block);
    return () => {
      document.removeEventListener('contextmenu', block);
      document.removeEventListener('selectstart', block);
      document.removeEventListener('dragstart', block);
      document.removeEventListener('copy', block);
      document.removeEventListener('cut', block);
    };
  }, [opened, content]);

  useEffect(() => {
    if (!opened || content?.kind !== 'file' || content.delivery !== 'view') {
      setPreviewUrl('');
      return;
    }
    const blob = new Blob([unb64(content.data)], { type: content.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [opened, content]);

  async function createShare(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    setLink('');
    try {
      if (!API) throw new Error('Сервер ещё не подключён.');
      if (!text.trim() && !file) throw new Error('Введи текст или прикрепи файл.');

      let payload: Payload;
      if (file) {
        if (file.size > MAX_FILE_BYTES) throw new Error('Максимальный размер файла — 8 МБ.');
        const data = b64(new Uint8Array(await file.arrayBuffer()));
        payload = { kind: 'file', name: file.name, mime: file.type || 'application/octet-stream', data, delivery: fileDelivery };
      } else {
        payload = { kind: 'text', text };
      }

      const key = randomSecret();
      const token = randomSecret();
      const ciphertext = await encrypt(JSON.stringify(payload), key);
      const res = await fetch(API + '/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: token, ciphertext, pin, expiresIn: Number(ttl) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось создать ссылку');
      const url = location.origin + BASE + 's/' + data.id + '#' + key + '.' + token;
      setLink(url);
      setMessage('Готово. Содержимое зашифровано в браузере.');
    } catch (err: any) {
      setMessage(err.message || 'Ошибка сети');
    } finally {
      setBusy(false);
    }
  }

  async function openShare(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      if (!API) throw new Error('Сервер ещё не подключён.');
      if (!secret || !accessToken) throw new Error('В ссылке отсутствует ключ или токен. Откройте исходную ссылку целиком.');
      const res = await fetch(API + '/api/shares/' + shareId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: accessToken, pin: viewPin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ссылка недоступна');
      const decoded = JSON.parse(await decrypt(data.ciphertext, secret)) as Payload;
      if (decoded.kind !== 'text' && decoded.kind !== 'file') throw new Error('Неизвестный формат секрета.');
      setContent(decoded);
      setOpened(true);
    } catch (err: any) {
      setMessage(err.message || 'Ошибка сети');
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadFile(payload: Extract<Payload, { kind: 'file' }>) {
    const blob = new Blob([unb64(payload.data)], { type: payload.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = payload.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="shell">
      <header>
        <div className="logo">S<span>·</span>S</div>
        <div><strong>Secure Share</strong><small>Private by design</small></div>
        <span className="tag">E2E ENCRYPTED</span>
      </header>
      <section className="hero">
        <div className="eyebrow">SHARE WITHOUT EXPOSING</div>
        <h1>{isViewer ? 'Полученный секрет' : 'Передавай приватно.'}<br /><em>{isViewer ? 'Одноразовый доступ.' : 'Без лишних следов.'}</em></h1>
        <p>{isViewer ? 'После открытия ссылка станет недоступна.' : 'Создай ссылку, которая откроется один раз. Текст и файлы шифруются прямо в браузере.'}</p>
      </section>
      <section className="panel">
        {!isViewer ? (
          <form onSubmit={createShare}>
            <label>Текст или сообщение</label>
            <textarea
              value={text}
              onChange={e => { setText(e.target.value); if (e.target.value && file) { setFile(null); if (fileInput.current) fileInput.current.value = ''; } }}
              placeholder="Вставь пароль, сообщение или другую информацию…"
              rows={6}
              maxLength={8000000}
            />
            <div style={{ textAlign: 'center', color: '#8290a9', fontSize: 11, margin: '16px 0' }}>ИЛИ ПРИКРЕПИ ФАЙЛ</div>
            <input
              ref={fileInput}
              type="file"
              onChange={e => { const selected = e.target.files?.[0] || null; setFile(selected); if (selected) setText(''); setMessage(selected && selected.size > MAX_FILE_BYTES ? 'Максимальный размер файла — 8 МБ.' : ''); }}
              style={{ padding: 12, marginBottom: 8 }}
            />
            {file && <>
              <p className="notice">Прикреплён: {file.name} · {formatSize(file.size)} <button type="button" className="copy" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }}>Убрать</button></p>
              <div style={{ margin: '16px 0' }}>
                <label>Что должен сделать получатель?</label>
                <div className="fields">
                  <button type="button" className={fileDelivery === 'download' ? '' : 'copy'} onClick={() => setFileDelivery('download')}>Скачать файл</button>
                  <button type="button" className={fileDelivery === 'view' ? '' : 'copy'} onClick={() => setFileDelivery('view')}>Одноразовый просмотр</button>
                </div>
                {fileDelivery === 'view' && <p className="notice">Просмотр прямо на странице поддерживается для изображений и PDF. Для остальных форматов браузер может предложить скачать файл.</p>}
              </div>
            </>}
            <div className="fields">
              <div><label>PIN-код <small>(необязательно)</small></label><input value={pin} onChange={e => setPin(e.target.value)} placeholder="Минимум 4 символа" minLength={pin ? 4 : undefined} /></div>
              <div><label>Срок действия</label><select value={ttl} onChange={e => setTtl(e.target.value)}><option value="60">1 час</option><option value="1440">24 часа</option><option value="10080">7 дней</option></select></div>
            </div>
            <button disabled={busy || (!text.trim() && !file) || Boolean(file && file.size > MAX_FILE_BYTES)}>{busy ? 'Шифруем и создаём…' : 'Создать одноразовую ссылку'} <span>↗</span></button>
          </form>
        ) : !opened ? (
          <form onSubmit={openShare}>
            <label>PIN-код, если он установлен</label>
            <input value={viewPin} onChange={e => setViewPin(e.target.value)} placeholder="Введите PIN" />
            <button disabled={busy}>{busy ? 'Проверяем…' : 'Открыть секрет'} <span>↗</span></button>
          </form>
        ) : (
          <div>
            <label>Полученное содержимое</label>
            {content?.kind === 'text' ? (
              <>
                <pre className="secret">{content.text}</pre>
                <button type="button" onClick={() => copy(content.text)}>{copied ? 'Скопировано ✓' : 'Копировать текст'}</button>
              </>
            ) : content?.kind === 'file' ? (
              <div className="secret">
                <strong>{content.name}</strong>
                <p className="notice">Файл расшифрован в браузере · {content.mime || 'Неизвестный тип'}</p>
                {content.delivery === 'view' ? (
                  <div
                    className="protected-stage"
                    onContextMenu={event => event.preventDefault()}
                    onDragStart={event => event.preventDefault()}
                    style={{ position: 'relative', overflow: 'hidden', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as React.CSSProperties}
                  >
                    {previewUrl && content.mime.startsWith('image/') ? (
                      <img src={previewUrl} alt={content.name} draggable={false} style={{ display: 'block', maxWidth: '100%', maxHeight: '65vh', margin: '16px auto', objectFit: 'contain', pointerEvents: 'none' }} />
                    ) : previewUrl && content.mime === 'application/pdf' ? (
                      <iframe title={content.name} src={previewUrl} style={{ width: '100%', height: '65vh', border: 0, marginTop: 16, background: '#fff' }} />
                    ) : (
                      <p className="notice">Этот формат не поддерживает встроенный просмотр в браузере. Для него доступно только скачивание.</p>
                    )}
                    {!protectedHidden && (
                      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(4, 1fr)', overflow: 'hidden' }}>
                        {Array.from({ length: 8 }, (_, index) => (
                          <span key={index} style={{ alignSelf: 'center', justifySelf: 'center', transform: 'rotate(-28deg)', color: 'rgba(12, 35, 29, .42)', background: 'rgba(255,255,255,.16)', fontSize: 11, fontWeight: 800, letterSpacing: 1, padding: '5px 8px', whiteSpace: 'nowrap' }}>SECURE SHARE · ONE-TIME</span>
                        ))}
                      </div>
                    )}
                    {protectedHidden && (
                      <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center', background: '#090d18', color: '#7ce0bf', textAlign: 'center', padding: 24 }}>
                        <div><strong>Просмотр скрыт</strong><p style={{ color: '#aab4c5', fontSize: 12 }}>Вернись на страницу, чтобы продолжить.</p></div>
                      </div>
                    )}
                  </div>
                ) : (
                  <button type="button" onClick={() => downloadFile(content)}>Скачать файл ↓</button>
                )}
              </div>
            ) : null}
            <p className="notice">Секрет открыт. Повторно получить его по этой ссылке нельзя.</p>
          </div>
        )}
        {message && <p className="message">{message}</p>}
        {link && <div className="linkbox"><label>Твоя приватная ссылка</label><div><input readOnly value={link} /><button type="button" className="copy" onClick={() => copy(link)}>{copied ? 'Скопировано' : 'Копировать'}</button></div><p>Отправь ссылку получателю. Не удаляй часть после символа # — там находится ключ расшифровки.</p></div>}
      </section>
      <footer><span>SECURE SHARE / MVP</span><span>Ключ не отправляется на сервер · AES-256-GCM</span></footer>
    </main>
  );
}
