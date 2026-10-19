-- =============================================================================
-- PORTARIA PRIME — 0900: catálogo inicial de planos (HIPÓTESES COMERCIAIS)
-- Valores do PROMPT_MESTRE, ainda não aprovados. Entram NÃO publicados:
-- o superadministrador revisa e publica no painel antes de aceitar clientes.
-- O seed de demonstração (supabase/seed/demo.sql) publica para testes.
-- =============================================================================

insert into public.plans (code, name, description, sort_order, is_custom, published) values
  ('essencial', 'Essencial', 'Para condomínios pequenos com uma portaria.', 1, false, false),
  ('profissional', 'Profissional', 'OCR de etiquetas, WhatsApp e totem para condomínios médios.', 2, false, false),
  ('prime', 'Prime', 'Volume maior, várias portarias e relatórios ampliados.', 3, false, false),
  ('sob-medida', 'Sob medida', 'Condições negociadas para grandes condomínios e administradoras.', 4, true, false)
on conflict (code) do nothing;

insert into public.plan_prices (plan_id, cycle, amount_cents)
select p.id, v.cycle, v.amount from public.plans p
join (values
  ('essencial', 'monthly', 9900), ('essencial', 'quarterly', 28200), ('essencial', 'yearly', 99000),
  ('profissional', 'monthly', 14900), ('profissional', 'quarterly', 55000), ('profissional', 'yearly', 190000),
  ('prime', 'monthly', 34900), ('prime', 'quarterly', 89900), ('prime', 'yearly', 269900)
) as v(code, cycle, amount) on v.code = p.code
on conflict do nothing;

insert into public.plan_entitlements (plan_id, max_units, max_concierges, ocr_monthly, whatsapp_monthly, storage_mb,
  feature_ocr, feature_whatsapp, feature_totem, feature_reports_plus)
select p.id, v.u, v.c, v.ocr, v.wa, v.mb, v.f_ocr, v.f_wa, v.f_totem, v.f_rep from public.plans p
join (values
  ('essencial', 80, 1, 0, 0, 2048, false, false, false, false),
  ('profissional', 400, 2, 600, 1500, 10240, true, true, true, false),
  ('prime', 600, 4, 1500, 4000, 20480, true, true, true, true),
  ('sob-medida', 100000, 50, 0, 0, 51200, true, true, true, true)
) as v(code, u, c, ocr, wa, mb, f_ocr, f_wa, f_totem, f_rep) on v.code = p.code
on conflict (plan_id) do nothing;
