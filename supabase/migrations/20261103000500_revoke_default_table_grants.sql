-- =============================================================================
-- Correção de segurança: no Supabase hospedado, tabelas novas em public herdam
-- privilégios padrão (ALL, inclusive TRUNCATE, que o RLS NÃO bloqueia) para anon e
-- authenticated. O banco local e os testes não têm esses padrões, por isso não pegaram.
-- Estas três tabelas são lidas por RLS (só SELECT) e escritas apenas por RPCs
-- SECURITY DEFINER: fica só o SELECT para authenticated; anon sem nada.
-- Idempotente e só restritiva (não concede nada novo).
-- =============================================================================

revoke all on public.access_requests, public.privacy_terms, public.privacy_acknowledgements from anon, authenticated;
grant select on public.access_requests, public.privacy_terms, public.privacy_acknowledgements to authenticated;
grant all on public.access_requests, public.privacy_terms, public.privacy_acknowledgements to service_role;

-- Daqui para frente, tabelas criadas por estas migrations não herdam acesso de anon/authenticated:
-- cada migration concede explicitamente o que precisa (padrão já seguido pelas demais tabelas).
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
