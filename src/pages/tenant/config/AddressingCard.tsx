import React, { useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useTenant } from '../../../lib/tenant';
import { unitName } from '../../../lib/format';
import { Button, Card, Field, Input, useAction } from '../../../components/ui';

/** Presets de nomenclatura; valores batem com o check de tenant_settings.condo_type. */
export const ADDRESS_PRESETS = [
  ['vertical', 'Prédio com blocos', 'Bloco', 'Apartamento'],
  ['vertical_torre', 'Prédio com torres', 'Torre', 'Unidade'],
  ['horizontal_casas', 'Condomínio de casas', 'Rua', 'Casa'],
  ['horizontal_lotes', 'Loteamento', 'Quadra', 'Lote'],
  ['personalizado', 'Personalizado', '', ''],
] as const;

/** Configurações → Condomínio: como o condomínio chama o agrupamento e a unidade. Só muda os textos; dados ficam iguais. */
export function AddressingCard() {
  const t = useTenant();
  const [s, setS] = useState({ type: t.condoType, group: t.unitLabels.group, number: t.unitLabels.number });
  const { busy, run } = useAction();
  if (!t.can('settings')) return null;
  const ok = [s.group, s.number].every((v) => v.trim().length >= 1 && v.trim().length <= 20);
  const pick = (type: string) => {
    const p = ADDRESS_PRESETS.find((x) => x[0] === type)!;
    setS(type === 'personalizado' ? { ...s, type } : { type, group: p[2], number: p[3] });
  };
  const save = () => run(async () => {
    const { error } = await supabase.from('tenant_settings')
      .update({ condo_type: s.type, unit_group_label: s.group.trim(), unit_number_label: s.number.trim() }).eq('tenant_id', t.tenant.id);
    if (error) throw new Error('Não foi possível salvar a nomenclatura.');
    await t.reload();
  }, 'Nomenclatura salva.');
  const text = (k: 'group' | 'number') => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, type: 'personalizado', [k]: e.target.value.slice(0, 20) });
  return (
    <Card className="space-y-3" id="nomenclatura">
      <div>
        <p className="font-semibold">Endereçamento das unidades</p>
        <p className="text-sm text-muted">Como o condomínio identifica cada endereço. Muda os nomes nas telas, relatórios, portal e etiquetas; as unidades cadastradas continuam as mesmas.</p>
      </div>
      <div role="radiogroup" aria-label="Tipo de condomínio" className="flex flex-wrap gap-2">
        {ADDRESS_PRESETS.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={s.type === id} onClick={() => pick(id)}
            className={`min-h-11 px-3 rounded-xl border text-sm ${s.type === id ? 'border-secondary ring-1 ring-secondary' : 'border-line hover:bg-surface-2'}`}>{label}</button>
        ))}
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Nome do agrupamento (ex.: Bloco, Torre, Quadra)"><Input value={s.group} onChange={text('group')} maxLength={20} /></Field>
        <Field label="Nome da unidade (ex.: Apartamento, Casa, Lote)"><Input value={s.number} onChange={text('number')} maxLength={20} /></Field>
      </div>
      <p className="text-sm rounded-xl bg-surface-2 p-3" aria-label="Prévia da nomenclatura">
        Prévia: {ok ? unitName('A', '12', { group: s.group, number: s.number }) : 'preencha os dois nomes (até 20 caracteres).'}
      </p>
      <Button onClick={save} loading={busy} disabled={!ok}>Salvar</Button>
    </Card>
  );
}
