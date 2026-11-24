import { useEffect, useState } from 'react';

const API = (import.meta as any).env.VITE_API_URL?.replace(/\/$/, '') || '';
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const randomSecret = () => b64(crypto.getRandomValues(new Uint8Array(32)));
async function encrypt(value: string, secret: string) {
  const key = await crypto.subtle.importKey('raw',unb64(secret),{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(value));
  return b64(new Uint8Array([...iv,...new Uint8Array(data)]));
}
async function decrypt(value: string, secret: string) {
  const bytes=unb64(value); const key=await crypto.subtle.importKey('raw',unb64(secret),{name:'AES-GCM'},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12));
  return new TextDecoder().decode(plain);
}
export default function App() {
  const [text,setText]=useState(''); const [pin,setPin]=useState(''); const [ttl,setTtl]=useState('1440');
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState(''); const [link,setLink]=useState('');
  const [opened,setOpened]=useState(false); const [content,setContent]=useState(''); const [viewPin,setViewPin]=useState('');
  const [shareId,setShareId]=useState(''); const [secret,setSecret]=useState('');
  useEffect(()=>{ const match=location.pathname.match(/^\/s\/([\w-]+)$/); if(match){setShareId(match[1]);setSecret(location.hash.slice(1));} },[]);
  const isViewer=Boolean(shareId);
  async function createShare(e:React.FormEvent) {
    e.preventDefault(); setBusy(true);setMessage('');setLink('');
    try {
      const key=randomSecret(); const cipher=await encrypt(text,key);
      const res=await fetch(API+'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:key,ciphertext:cipher,pin,expiresIn:Number(ttl)})});
      const data=await res.json(); if(!res.ok) throw new Error(data.error||'Не удалось создать ссылку');
      const url=location.origin+'/s/'+data.id+'#'+key; setLink(url); setMessage('Готово. Секрет зашифрован в браузере.');
    } catch(err:any){setMessage(err.message||'Ошибка сети');} finally{setBusy(false);}
  }
  async function openShare(e:React.FormEvent) {
    e.preventDefault(); setBusy(true);setMessage('');
    try {
      if(!secret) throw new Error('В ссылке отсутствует ключ расшифровки. Откройте исходную ссылку целиком.');
      const res=await fetch(API+'/api/shares/'+shareId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,pin:viewPin})});
      const data=await res.json(); if(!res.ok) throw new Error(data.error||'Ссылка недоступна');
      setContent(await decrypt(data.ciphertext,secret));setOpened(true);
    } catch(err:any){setMessage(err.message||'Ошибка сети');} finally{setBusy(false);}
  }
  async function copy(){await navigator.clipboard.writeText(link);setMessage('Ссылка скопирована.');}
  return <main className="shell"><header><div className="logo">S<span>·</span>S</div><div><strong>Secure Share</strong><small>Private by design</small></div><span className="tag">E2E ENCRYPTED</span></header>
    <section className="hero"><div className="eyebrow">SHARE WITHOUT EXPOSING</div><h1>{isViewer?'Полученный секрет':'Передавай приватно.'}<br/><em>{isViewer?'Одноразовый доступ.':'Без лишних следов.'}</em></h1><p>{isViewer?'После открытия ссылка станет недоступна.':'Создай ссылку, которая откроется один раз. Содержимое шифруется прямо в браузере.'}</p></section>
    <section className="panel">{!isViewer?<form onSubmit={createShare}><label>Секретное сообщение</label><textarea value={text} onChange={e=>setText(e.target.value)} placeholder="Вставь пароль, заметку или другую информацию…" required maxLength={8000000}/><div className="fields"><div><label>PIN-код <small>(необязательно)</small></label><input value={pin} onChange={e=>setPin(e.target.value)} placeholder="Минимум 4 символа" minLength={pin?4:undefined}/></div><div><label>Срок действия</label><select value={ttl} onChange={e=>setTtl(e.target.value)}><option value="60">1 час</option><option value="1440">24 часа</option><option value="10080">7 дней</option></select></div></div><button disabled={busy||!text.trim()}>{busy?'Создаём…':'Создать одноразовую ссылку'} <span>↗</span></button></form>:<>{!opened?<form onSubmit={openShare}><label>PIN-код, если он установлен</label><input value={viewPin} onChange={e=>setViewPin(e.target.value)} placeholder="Введите PIN"/><button disabled={busy}>{busy?'Проверяем…':'Открыть секрет'} <span>↗</span></button></form>:<div><label>Содержимое</label><pre className="secret">{content}</pre><p className="notice">Секрет открыт. Повторно получить его по этой ссылке нельзя.</p></div>}</>}
      {message&&<p className="message">{message}</p>}{link&&<div className="linkbox"><label>Твоя приватная ссылка</label><div><input readOnly value={link}/><button type="button" className="copy" onClick={copy}>Копировать</button></div><p>Отправь ссылку получателю. Не удаляй часть после символа # — там находится ключ расшифровки.</p></div>}</section>
    <footer><span>SECURE SHARE / MVP</span><span>Ключ не отправляется на сервер · AES-256-GCM</span></footer>
  </main>;
}
