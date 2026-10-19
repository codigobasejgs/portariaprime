-- ==============================================================================
-- MIGRATION: Suporte a Múltiplos Moradores por Unidade
-- ==============================================================================
-- Remove a restrição de "1 morador por unidade" (profiles_unit_unico_idx).
-- Até 5 moradores da mesma residência (titular, cônjuge, filhos, etc.) podem
-- criar suas contas de login no aplicativo com e-mails diferentes e enxergar
-- as mesmas encomendas daquela unidade.

DROP INDEX IF EXISTS public.profiles_unit_unico_idx;

-- Índice não-único para manter a performance das consultas de unit_id por morador
CREATE INDEX IF NOT EXISTS profiles_unit_idx
  ON public.profiles (unit_id)
  WHERE unit_id IS NOT NULL AND role = 'morador';
