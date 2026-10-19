-- ==============================================================================
-- VILLAGE AZALEIA — MIGRATION: Múltiplos Moradores por Unidade
-- ==============================================================================
-- Execute este script no SQL Editor do Supabase (https://supabase.com/dashboard).
-- Ele remove a restrição de "1 usuário por unidade", permitindo que até 5 pessoas
-- do mesmo apartamento (titular, cônjuge, filhos) criem suas próprias contas
-- com e-mails diferentes e acessem as mesmas encomendas.

-- 1. Remove a restrição que impede mais de um morador por unidade
DROP INDEX IF EXISTS public.profiles_unit_unico_idx;

-- 2. Cria índice não-único para manter as consultas rápidas
CREATE INDEX IF NOT EXISTS profiles_unit_idx
  ON public.profiles (unit_id)
  WHERE unit_id IS NOT NULL AND role = 'morador';

-- 3. Vincula o perfil da Giuliana à unidade do Jefferson (B12B-A23)
UPDATE public.profiles
   SET unit_id = 'B12B-A23'
 WHERE role = 'morador'
   AND name ILIKE '%Giuliana%';
