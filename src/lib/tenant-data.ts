import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_UNIT_LABELS, type UnitLabels } from './format';

/** Falhas de qualquer parte do contexto precisam ser visíveis e recuperáveis. */
export async function loadTenantInfo(client: SupabaseClient, overview: () => Promise<any>, tenantId: string) {
  const [tenant, branding, subscription, settings] = await Promise.all([
    client.from('tenants').select('id, slug, name, timezone, status').eq('id', tenantId).single(),
    client.from('tenant_branding').select('*').eq('tenant_id', tenantId).maybeSingle(),
    overview(),
    client.from('tenant_settings').select('unit_group_label, unit_number_label, condo_type').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (tenant.error || !tenant.data) throw new Error('Condomínio indisponível.');
  if (branding.error) throw new Error('Não foi possível carregar a marca do condomínio.');
  // ponytail: banco sem a migration 0100 cai no padrão; remover fallback quando todos os ambientes tiverem as colunas.
  const s: any = settings.error ? null : settings.data;
  const unitLabels: UnitLabels = {
    group: s?.unit_group_label?.trim() || DEFAULT_UNIT_LABELS.group,
    number: s?.unit_number_label?.trim() || DEFAULT_UNIT_LABELS.number,
  };
  return { tenant: tenant.data, branding: branding.data, overview: subscription, unitLabels, condoType: (s?.condo_type as string) || 'vertical' };
}
