import React, { useState } from 'react';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { navigate } from '../lib/router';
import { Alert, Button, Field, Input, Select, useAction } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';
import { PorterFaceCapture, type FaceCapture } from '../components/PorterFaceCapture';
import { DEMO } from '../demo/mode';

/** Login do porteiro cadastrado: documento + senha (sempre) + rosto comparado no servidor com a referência. Sem câmera: só senha, registrado como alerta. */
export function PorterLoginPage({ slug }: { slug: string }) {
  const [f, setF] = useState({ documentType: 'CPF', document: '', password: '' });
  const [noCamera, setNoCamera] = useState(false);
  const [face, setFace] = useState<FaceCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    run(async () => {
      try {
        const r = await api<{ access_token: string; refresh_token: string }>('/api/team/porter-login', { slug, documentType: f.documentType, document: f.document, password: f.password,
          method: noCamera ? 'password' : 'face', descriptor: face?.descriptor, photo: face?.photo, liveness: face?.liveness });
        if (DEMO) return navigate(`/c/${slug}/portaria?perfil=porteiro`, true);
        // Sessão emitida pelo servidor após senha + face; o turno fica preso a este session_id.
        const { error: se } = await supabase.auth.setSession({ access_token: r.access_token, refresh_token: r.refresh_token });
        if (se) throw new Error(se.message);
        navigate(`/c/${slug}/portaria`, true);
      } catch (err) { setFace(null); setError((err as Error).message); }
    });
  };
  return <main className="max-w-md mx-auto px-4 py-8 space-y-5">
    <PortariaPrimeLogo />
    <h1 className="text-2xl font-semibold">Login da portaria</h1>
    <p className="text-sm text-muted">Início de turno (12h). Documento, senha e verificação facial do porteiro que assume.</p>
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-[7rem_1fr] gap-2">
        <Field label="Documento"><Select value={f.documentType} onChange={(e) => setF({ ...f, documentType: e.target.value })}><option>CPF</option><option>RG</option><option>CNH</option></Select></Field>
        <Field label="Número"><Input required inputMode="numeric" autoComplete="username" value={f.document} onChange={(e) => setF({ ...f, document: e.target.value })} /></Field>
      </div>
      <Field label="Senha"><Input required type="password" autoComplete="current-password" maxLength={72} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      <label className="flex gap-2 items-center text-sm min-h-9"><input type="checkbox" checked={noCamera} onChange={(e) => { setNoCamera(e.target.checked); setFace(null); }} /> Sem câmera neste aparelho (entrada só com senha; fica registrada como alerta para o síndico)</label>
      {!noCamera && (face ? <Alert tone="success">Rosto capturado. <button type="button" className="underline" onClick={() => setFace(null)}>Capturar de novo</button></Alert> : <PorterFaceCapture onCapture={setFace} />)}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" className="w-full" loading={busy} disabled={!noCamera && !face}>Iniciar turno</Button>
    </form>
    <p className="text-xs text-muted"><a className="underline" href="/entrar">Síndico ou porteiro sem cadastro biométrico: login comum</a></p>
  </main>;
}
