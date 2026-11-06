import { supabase } from './supabase';
import { rpc } from './api';

export interface PackageRow {
  id: string; status: string; tracking_code: string | null; carrier: string; recipient_name: string | null;
  notes: string | null; registered_via: string; unit_id: string | null; unit_block: string | null; unit_label: string | null;
  storage_location_id: string | null; storage_code: string | null; received_at: string; stored_at: string | null;
  notified_at: string | null; picked_up_at: string | null; picked_up_by_name: string | null; pickup_method: string | null;
  resolution_reason: string | null; courier_name: string | null; received_by_name?: string | null;
}

export interface UnitRow { id: string; block: string | null; label: string; active: boolean }
export interface StorageLoc {
  id: string; code: string; capacity: number; used?: number; free?: number; is_contingency: boolean; concierge_location_id: string;
  rack?: string | null; shelf?: string | null; concierge?: string | null; notes?: string | null;
}

/** "Portaria › Estante A › Prateleira 2" (ou o código, em locais antigos). */
export const locationName = (s: { code: string; rack?: string | null; shelf?: string | null; concierge?: string | null }) =>
  [s.concierge, s.rack, s.shelf].filter(Boolean).join(' › ') || s.code;

/** Locais ativos com vagas calculadas no servidor (mesma ordem da escolha automática). */
export const loadAvailability = (tenantId: string) => rpc<StorageLoc[]>('storage_availability', { p_tenant: tenantId });

export interface ListParams { status?: string | null; from?: string | null; to?: string | null; search?: string | null; limit?: number }

/** Página por cursor (keyset): não perde nem repete registros entre páginas. */
export async function listPackages(tenantId: string, p: ListParams, cursor?: { at: string; id: string }) {
  return rpc<PackageRow[]>('list_packages', {
    p_tenant: tenantId, p_status: p.status || null, p_from: p.from || null, p_to: p.to || null,
    p_search: p.search?.trim() || null, p_limit: p.limit || 50,
    p_cursor_at: cursor?.at || null, p_cursor_id: cursor?.id || null,
  });
}

export async function listAllPackages(tenantId: string, p: ListParams) {
  const out: PackageRow[] = [];
  let cursor: { at: string; id: string } | undefined;
  for (;;) {
    const page = await listPackages(tenantId, { ...p, limit: 500 }, cursor);
    out.push(...page);
    if (page.length < 500) return out;
    const last = page[page.length - 1];
    cursor = { at: last.received_at, id: last.id };
  }
}

export async function loadUnits(tenantId: string): Promise<UnitRow[]> {
  const { data, error } = await supabase.from('units').select('id, block, label, active').eq('tenant_id', tenantId)
    .order('block', { nullsFirst: true }).order('label').limit(5000);
  if (error) throw new Error('Não foi possível carregar as unidades.');
  return data || [];
}

export async function loadStorage(tenantId: string): Promise<StorageLoc[]> {
  const { data, error } = await supabase.from('storage_locations').select('id, code, rack, shelf, notes, capacity, is_contingency, concierge_location_id, active, sort_order')
    .eq('tenant_id', tenantId).eq('active', true).order('sort_order').order('code');
  if (error) throw new Error('Não foi possível carregar os locais.');
  return data || [];
}

/** Busca simples de unidade por texto (vertical e horizontal). */
export { matchUnits } from './unit-match';
