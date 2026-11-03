import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Button, Field, Input, Modal, useAction } from './ui';

/**
 * Ações sensíveis: o banco exige login recente (app.mdm_require_recent_auth → "Confirme sua senha").
 * Ao receber esse erro, pede a senha de novo e repete a mesma ação. Outros erros sobem normalmente.
 */
export function useSensitive(reason: string) {
  const [pending, setPending] = useState<null | (() => Promise<void>)>(null);
  const guard = (fn: () => Promise<void>) => async () => {
    try { await fn(); } catch (e: any) {
      if (/Confirme sua senha/.test(e?.message || '')) setPending(() => fn); else throw e;
    }
  };
  const dialog = pending && <ReauthModal reason={reason} onClose={() => setPending(null)} onDone={async () => { const f = pending; setPending(null); await f(); }} />;
  return { guard, dialog };
}

function ReauthModal({ reason, onClose, onDone }: { reason: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="Confirme sua senha" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(async () => {
        const { data } = await supabase.auth.getUser();
        const email = data.user?.email;
        if (!email) throw new Error('Sessão sem e-mail. Entre novamente.');
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) { setError('Senha incorreta.'); return; }
        await onDone();
      }); }}>
        <p className="text-sm text-muted">{reason}</p>
        <Field label="Senha" error={error}><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Button type="submit" loading={busy}>Confirmar</Button>
      </form>
    </Modal>
  );
}
