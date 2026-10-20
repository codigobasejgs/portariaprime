import { supabase } from './supabase';

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_custom: boolean;
  published: boolean;
  prices: { id: string; cycle: 'monthly' | 'quarterly' | 'yearly'; amount_cents: number; version: number; active: boolean }[];
  ent: {
    max_units: number; max_concierges: number; ocr_monthly: number; whatsapp_monthly: number; storage_mb: number;
    feature_ocr: boolean; feature_whatsapp: boolean; feature_totem: boolean; feature_reports_plus: boolean;
  } | null;
}

/** Catálogo publicado (RLS mostra só o publicado para quem não é superadmin). */
export async function loadCatalog(): Promise<PlanRow[]> {
  const [{ data: plans, error }, { data: prices }, { data: ents }] = await Promise.all([
    supabase.from('plans').select('*').order('sort_order'),
    supabase.from('plan_prices').select('*').eq('active', true),
    supabase.from('plan_entitlements').select('*'),
  ]);
  if (error) throw new Error('Não foi possível carregar os planos.');
  return (plans || []).map((p: any) => ({
    ...p,
    prices: (prices || []).filter((x: any) => x.plan_id === p.id),
    ent: (ents || []).find((e: any) => e.plan_id === p.id) || null,
  }));
}

export function featureList(p: PlanRow): string[] {
  const e = p.ent;
  if (!e) return [];
  const f = [
    p.is_custom ? 'Unidades e portarias sob medida' : `Até ${e.max_units} unidades`,
    p.is_custom ? '' : `${e.max_concierges} portaria${e.max_concierges > 1 ? 's' : ''}`,
    'Recebimento, guarda e retirada com QR Code',
    'Assinatura na retirada e comprovante',
    'Moradores, equipe e personalização da marca',
    'Avisos no app e por e-mail',
  ];
  if (e.feature_ocr) f.push(p.is_custom ? 'Leitura de etiquetas (OCR)' : `Leitura de etiquetas (OCR): ${e.ocr_monthly}/mês`);
  if (e.feature_whatsapp) f.push(p.is_custom ? 'Avisos por WhatsApp' : `Avisos por WhatsApp: ${e.whatsapp_monthly}/mês`);
  if (e.feature_totem) f.push('Totem de autoatendimento para entregadores');
  f.push(e.feature_reports_plus ? 'Relatórios ampliados' : 'Relatórios básicos e exportação CSV');
  return f.filter(Boolean);
}
