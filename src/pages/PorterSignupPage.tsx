import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { query } from '../lib/router';
import { Alert, Button, Field, Input, Select, Spinner, useAction } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';
import { PorterFaceCapture, type FaceCapture } from '../components/PorterFaceCapture';

type Preview = { tenant_id: string; name: string; approval: boolean; term: { version: string; content: string; hash: string } };
const pwOk = (a: string, b: string) => a.length >= 10 && /[A-Za-z]/.test(a) && /\d/.test(a) && a === b;

/** Cadastro do porteiro pelo link/QR do síndico: dados, senha, termo biométrico e referência facial (primeira captura, imutável). */
export function PorterSignupPage({ slug }: { slug: string }) {
  const token = query('t') || '';
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ fullName: '', documentType: 'CPF', document: '', phone: '', email: '', password: '', confirm: '', consent: false });
  const [face, setFace] = useState<FaceCapture | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!/^[a-f0-9]{64}$/.test(token)) { setError('Link inválido. Peça um novo link ao síndico.'); return; }
    api<Preview>('/api/team/porter-preview', { slug, token }).then(setPreview).catch((e) => setError(e.message));
  }, [slug, token]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwOk(f.password, f.confirm) || !face || !f.consent || !preview) return;
    run(async () => {
      const r = await api<{ status: string }>('/api/team/porter-signup', { slug, token, fullName: f.fullName, documentType: f.documentType, document: f.document, phone: f.phone,
        email: f.email, password: f.password, consent: true, termHash: preview.term.hash, descriptor: face.descriptor, photo: face.photo, liveness: face.liveness });
      setDone(r.status);
    });
  };
  const wrap = (c: React.ReactNode) => <main className="max-w-lg mx-auto px-4 py-8 space-y-5"><PortariaPrimeLogo />{c}</main>;
  if (error) return wrap(<Alert tone="danger">{error}</Alert>);
  if (!preview) return wrap(<Spinner />);
  if (done) return wrap(<div className="space-y-3">
    <h1 className="text-2xl font-semibold">Cadastro enviado</h1>
    <Alert tone="success">{done === 'active' ? 'Cadastro concluído. Você já pode entrar.' : 'Cadastro recebido. O síndico precisa aprovar antes do primeiro acesso.'}</Alert>
    <p className="text-sm text-muted">Para entrar, use o login da portaria com documento, senha e verificação facial.</p>
    <Button className="w-full" onClick={() => { location.href = `/c/${slug}/equipe/entrar`; }}>Ir para o login da portaria</Button>
  </div>);
  return wrap(<form onSubmit={submit} className="space-y-4">
    <h1 className="text-2xl font-semibold">Cadastro de porteiro — {preview.name}</h1>
    <Field label="Nome completo"><Input required minLength={2} maxLength={120} autoComplete="name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <Field label="Documento"><Select value={f.documentType} onChange={(e) => setF({ ...f, documentType: e.target.value })}><option>CPF</option><option>RG</option><option>CNH</option></Select></Field>
      <Field label="Número"><Input required inputMode="numeric" autoComplete="off" value={f.document} onChange={(e) => setF({ ...f, document: e.target.value })} /></Field>
    </div>
    <Field label="Telefone (com DDD)"><Input required type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
    <Field label="E-mail" hint="Usado para recuperar a senha."><Input required type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
    <Field label="Senha" hint="Mínimo de 10 caracteres, com letras e números. Sempre exigida junto da verificação facial.">
      <Input required type="password" autoComplete="new-password" minLength={10} maxLength={72} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
    <Field label="Confirme a senha" error={f.confirm && f.password !== f.confirm ? 'As senhas não conferem.' : null}>
      <Input required type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
    <section className="space-y-2">
      <h2 className="font-semibold">Termo de consentimento biométrico (versão {preview.term.version})</h2>
      <p className="text-sm whitespace-pre-wrap border border-line rounded-xl p-3 max-h-48 overflow-y-auto">{preview.term.content}</p>
      <label className="flex gap-2 items-start text-sm min-h-9"><input type="checkbox" required className="mt-1" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> Li e autorizo o tratamento da minha foto e descritor facial conforme o termo acima.</label>
    </section>
    <section className="space-y-2">
      <h2 className="font-semibold">Referência facial</h2>
      <p className="text-sm text-muted">Esta primeira captura é a referência fixa dos seus logins. Só o síndico pode autorizar uma nova, com registro.</p>
      {face ? <Alert tone="success">Rosto capturado. <button type="button" className="underline" onClick={() => setFace(null)}>Capturar de novo</button></Alert>
        : f.consent ? <PorterFaceCapture enrollment onCapture={setFace} />
        : <p className="text-sm">Marque a autorização do termo acima para abrir a câmera.</p>}
    </section>
    <Button type="submit" className="w-full" loading={busy} disabled={!face || !f.consent || !pwOk(f.password, f.confirm)}>Concluir cadastro</Button>
  </form>);
}
