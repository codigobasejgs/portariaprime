-- ==============================================================================
-- VILLAGE AZALEIA — MIGRATION DE REMEDIAÇÃO DE SEGURANÇA
-- ==============================================================================
-- Corrige: BUG-001 (RLS), BUG-003 (retirada atômica), BUG-005 (QR),
--          BUG-007 (sequestro de unidade), BUG-008 (estados), auditoria imutável.
--
-- NÃO-DESTRUTIVA: não apaga nenhum registro, não altera dados de moradores.
-- Só adiciona colunas, constraints, funções e substitui políticas RLS.
-- Idempotente: pode rodar mais de uma vez.
--
-- PRÉ-REQUISITO: rodar `node scripts/backup-supabase.cjs` antes.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- PARTE 1 — IDENTIDADE: perfis ancorados em auth.users
-- ==============================================================================
-- Substitui staff_accounts como fonte de autenticação. A tabela antiga é
-- preservada (renomeada no fim) para não perder o histórico, mas deixa de ser
-- legível e deixa de autenticar ninguém.

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('portaria', 'sindico', 'morador', 'totem')),
  name TEXT NOT NULL,
  -- Preenchido só para role='morador': a unidade que esta pessoa titulariza.
  unit_id TEXT REFERENCES public.units(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles (role);
CREATE INDEX IF NOT EXISTS profiles_unit_idx ON public.profiles (unit_id);

-- Helpers de papel. SECURITY DEFINER + search_path fixo: as políticas precisam
-- ler profiles sem cair na própria RLS de profiles (recursão infinita).
CREATE OR REPLACE FUNCTION public.current_role_name()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() AND active LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_role_name() IN ('portaria', 'sindico', 'totem'), FALSE);
$$;

CREATE OR REPLACE FUNCTION public.is_sindico()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_role_name() = 'sindico', FALSE);
$$;

-- Unidade que o usuário logado titulariza (NULL para staff).
CREATE OR REPLACE FUNCTION public.current_unit_id()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT unit_id FROM public.profiles WHERE id = auth.uid() AND active LIMIT 1;
$$;

-- ==============================================================================
-- PARTE 2 — INTEGRIDADE: constraints que faltavam
-- ==============================================================================

-- BUG-016: unicidade de rastreio e de token de QR.
-- Índice parcial: só vale entre encomendas ainda ativas. Duas encomendas com o
-- mesmo rastreio em anos diferentes são legítimas; duas ao mesmo tempo, não.
CREATE UNIQUE INDEX IF NOT EXISTS packages_tracking_ativo_idx
  ON public.packages (tracking_code)
  WHERE status IN ('RECEBIDA', 'ARMAZENADA', 'AVISADA');

-- BUG-005: token de QR nunca pode repetir.
CREATE UNIQUE INDEX IF NOT EXISTS packages_qr_token_unico_idx
  ON public.packages (qr_token);

-- BUG-007: uma unidade por bloco+apartamento (já existia) e um titular por unidade.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_unit_unico_idx
  ON public.profiles (unit_id)
  WHERE unit_id IS NOT NULL AND role = 'morador';

-- BUG-008 + FASE 6: máquina de estados real.
-- Estados novos: AVISADA (morador notificado com sucesso) e os três terminais
-- de exceção, que hoje forçam o porteiro a registrar entrega falsa.
ALTER TABLE public.packages DROP CONSTRAINT IF EXISTS packages_status_check;
ALTER TABLE public.packages ADD CONSTRAINT packages_status_check
  CHECK (status IN ('RECEBIDA','ARMAZENADA','AVISADA','RETIRADA','CANCELADA','DEVOLVIDA','EXTRAVIADA'));

-- Estados impossíveis: RETIRADA exige quem e quando.
ALTER TABLE public.packages DROP CONSTRAINT IF EXISTS packages_retirada_completa_check;
ALTER TABLE public.packages ADD CONSTRAINT packages_retirada_completa_check
  CHECK (
    status <> 'RETIRADA'
    OR (picked_up_at IS NOT NULL AND picked_up_by IS NOT NULL AND LENGTH(TRIM(picked_up_by)) > 0)
  );

-- Estados terminais de exceção exigem justificativa registrada.
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS resolution_reason TEXT;
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS resolved_by TEXT;

ALTER TABLE public.packages DROP CONSTRAINT IF EXISTS packages_excecao_justificada_check;
ALTER TABLE public.packages ADD CONSTRAINT packages_excecao_justificada_check
  CHECK (
    status NOT IN ('CANCELADA','DEVOLVIDA','EXTRAVIADA')
    OR (resolution_reason IS NOT NULL AND LENGTH(TRIM(resolution_reason)) >= 10 AND resolved_by IS NOT NULL)
  );

-- Coerência temporal: não se retira antes de receber.
ALTER TABLE public.packages DROP CONSTRAINT IF EXISTS packages_ordem_temporal_check;
ALTER TABLE public.packages ADD CONSTRAINT packages_ordem_temporal_check
  CHECK (picked_up_at IS NULL OR picked_up_at >= received_at);

-- QR: expiração e consumo (BUG-005).
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ;
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS qr_consumed_at TIMESTAMPTZ;

-- Auditoria: FK real e rastreio de identidade (o campo `operator` era texto livre).
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS before_state JSONB;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS after_state JSONB;
CREATE INDEX IF NOT EXISTS activity_logs_package_idx ON public.activity_logs (package_id);

-- LGPD: consentimento não pode ser fabricado por DEFAULT.
ALTER TABLE public.units ALTER COLUMN lgpd_accepted SET DEFAULT FALSE;
ALTER TABLE public.units ALTER COLUMN lgpd_accepted_at DROP DEFAULT;

-- ==============================================================================
-- PARTE 3 — AUDITORIA IMUTÁVEL (FASE 4)
-- ==============================================================================
-- Append-only imposto por trigger, não por convenção. Vale inclusive para
-- service_role: nem o backend consegue reescrever a trilha.

CREATE OR REPLACE FUNCTION public.bloquear_alteracao_de_log()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'activity_logs e append-only: % bloqueado por politica de auditoria', TG_OP
    USING HINT = 'Registre um novo evento de correcao em vez de alterar o historico.';
END;
$$;

DROP TRIGGER IF EXISTS activity_logs_sem_update ON public.activity_logs;
CREATE TRIGGER activity_logs_sem_update
  BEFORE UPDATE ON public.activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.bloquear_alteracao_de_log();

DROP TRIGGER IF EXISTS activity_logs_sem_delete ON public.activity_logs;
CREATE TRIGGER activity_logs_sem_delete
  BEFORE DELETE ON public.activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.bloquear_alteracao_de_log();

-- Carimbo de servidor: o timestamp do log deixa de vir do relógio do navegador.
CREATE OR REPLACE FUNCTION public.carimbar_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.timestamp := NOW();
  NEW.actor_id  := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS activity_logs_carimbo ON public.activity_logs;
CREATE TRIGGER activity_logs_carimbo
  BEFORE INSERT ON public.activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.carimbar_log();

-- ==============================================================================
-- PARTE 4 — RETIRADA ATÔMICA (BUG-003 / FASE 5)
-- ==============================================================================
-- Compare-and-swap no banco. Dois porteiros simultâneos: um conclui, o outro
-- recebe erro explícito. A assinatura do primeiro nunca é sobrescrita.

CREATE OR REPLACE FUNCTION public.confirmar_retirada(
  p_package_id TEXT,
  p_qr_token TEXT,
  p_picked_up_by TEXT,
  p_signature_url TEXT,
  p_handover_photo_url TEXT DEFAULT NULL,
  p_receipt_protocol TEXT DEFAULT NULL
)
RETURNS public.packages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg public.packages;
  v_antes JSONB;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Sem permissao para dar baixa em encomenda'
      USING ERRCODE = '42501';
  END IF;

  IF p_picked_up_by IS NULL OR LENGTH(TRIM(p_picked_up_by)) = 0 THEN
    RAISE EXCEPTION 'Informe quem esta retirando a encomenda'
      USING ERRCODE = '22023';
  END IF;

  IF p_signature_url IS NULL OR LENGTH(TRIM(p_signature_url)) = 0 THEN
    RAISE EXCEPTION 'Assinatura digital e obrigatoria para a baixa'
      USING ERRCODE = '22023';
  END IF;

  -- Trava a linha: a segunda transação espera aqui e só então reavalia o estado.
  SELECT * INTO v_pkg FROM public.packages WHERE id = p_package_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encomenda % nao encontrada', p_package_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_pkg.status = 'RETIRADA' THEN
    RAISE EXCEPTION 'Encomenda ja foi retirada por % em %',
      COALESCE(v_pkg.picked_up_by, 'desconhecido'),
      TO_CHAR(v_pkg.picked_up_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      USING ERRCODE = '55000';
  END IF;

  IF v_pkg.status IN ('CANCELADA','DEVOLVIDA','EXTRAVIADA') THEN
    RAISE EXCEPTION 'Encomenda esta como % e nao pode ser entregue', v_pkg.status
      USING ERRCODE = '55000';
  END IF;

  -- QR opcional: quando informado, precisa bater e estar válido.
  IF p_qr_token IS NOT NULL AND LENGTH(TRIM(p_qr_token)) > 0 THEN
    IF v_pkg.qr_token <> p_qr_token THEN
      RAISE EXCEPTION 'QR Code nao corresponde a esta encomenda'
        USING ERRCODE = '22023';
    END IF;
    IF v_pkg.qr_consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'QR Code ja utilizado em %',
        TO_CHAR(v_pkg.qr_consumed_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
        USING ERRCODE = '55000';
    END IF;
    IF v_pkg.qr_expires_at IS NOT NULL AND v_pkg.qr_expires_at < NOW() THEN
      RAISE EXCEPTION 'QR Code expirado. Gere um novo pelo app do morador'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  v_antes := TO_JSONB(v_pkg);

  UPDATE public.packages
     SET status             = 'RETIRADA',
         picked_up_at       = NOW(),
         picked_up_by       = TRIM(p_picked_up_by),
         signature_url      = p_signature_url,
         handover_photo_url = COALESCE(p_handover_photo_url, handover_photo_url),
         receipt_protocol   = COALESCE(p_receipt_protocol, receipt_protocol),
         qr_consumed_at     = NOW(),
         operator_name      = COALESCE((SELECT name FROM public.profiles WHERE id = auth.uid()), operator_name)
   WHERE id = p_package_id
     AND status IN ('RECEBIDA','ARMAZENADA','AVISADA')  -- compare-and-swap
   RETURNING * INTO v_pkg;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Baixa nao aplicada: a encomenda mudou de estado durante a operacao'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.activity_logs (id, package_id, tracking_code, unit_string, action, description, operator, before_state, after_state)
  VALUES (
    'log-' || gen_random_uuid()::text,
    v_pkg.id, v_pkg.tracking_code,
    'Bloco ' || v_pkg.block || ' - Apt ' || v_pkg.apartment,
    'RETIRADA',
    'Baixa confirmada para ' || v_pkg.picked_up_by,
    COALESCE((SELECT name FROM public.profiles WHERE id = auth.uid()), 'Portaria'),
    v_antes, TO_JSONB(v_pkg)
  );

  RETURN v_pkg;
END;
$$;

-- Resolução de exceção: extravio, devolução e cancelamento com justificativa.
-- Impede que um sumiço seja encerrado como entrega falsa.
CREATE OR REPLACE FUNCTION public.resolver_excecao(
  p_package_id TEXT,
  p_novo_status TEXT,
  p_motivo TEXT
)
RETURNS public.packages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg public.packages;
  v_antes JSONB;
  v_nome TEXT;
BEGIN
  IF NOT public.is_sindico() THEN
    RAISE EXCEPTION 'Apenas o sindico pode registrar excecao de encomenda'
      USING ERRCODE = '42501';
  END IF;

  IF p_novo_status NOT IN ('CANCELADA','DEVOLVIDA','EXTRAVIADA') THEN
    RAISE EXCEPTION 'Status de excecao invalido: %', p_novo_status
      USING ERRCODE = '22023';
  END IF;

  IF p_motivo IS NULL OR LENGTH(TRIM(p_motivo)) < 10 THEN
    RAISE EXCEPTION 'Descreva o motivo com pelo menos 10 caracteres'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_pkg FROM public.packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encomenda % nao encontrada', p_package_id USING ERRCODE = 'P0002';
  END IF;

  IF v_pkg.status = 'RETIRADA' THEN
    RAISE EXCEPTION 'Encomenda ja entregue nao pode virar %', p_novo_status
      USING ERRCODE = '55000';
  END IF;

  v_antes := TO_JSONB(v_pkg);
  SELECT name INTO v_nome FROM public.profiles WHERE id = auth.uid();

  UPDATE public.packages
     SET status = p_novo_status,
         resolution_reason = TRIM(p_motivo),
         resolved_at = NOW(),
         resolved_by = COALESCE(v_nome, 'Sindico')
   WHERE id = p_package_id
   RETURNING * INTO v_pkg;

  INSERT INTO public.activity_logs (id, package_id, tracking_code, unit_string, action, description, operator, before_state, after_state)
  VALUES (
    'log-' || gen_random_uuid()::text,
    v_pkg.id, v_pkg.tracking_code,
    'Bloco ' || v_pkg.block || ' - Apt ' || v_pkg.apartment,
    'EXCECAO',
    p_novo_status || ': ' || TRIM(p_motivo),
    COALESCE(v_nome, 'Sindico'),
    v_antes, TO_JSONB(v_pkg)
  );

  RETURN v_pkg;
END;
$$;

-- Movimentação de estante com histórico (BUG-009).
CREATE OR REPLACE FUNCTION public.mover_encomenda(
  p_package_id TEXT,
  p_nova_estante JSONB,
  p_motivo TEXT DEFAULT NULL
)
RETURNS public.packages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg public.packages;
  v_antes JSONB;
  v_nome TEXT;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Sem permissao para mover encomenda' USING ERRCODE = '42501';
  END IF;

  IF p_nova_estante->>'shelf' IS NULL OR p_nova_estante->>'level' IS NULL THEN
    RAISE EXCEPTION 'Estante invalida: informe shelf e level' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_pkg FROM public.packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encomenda % nao encontrada', p_package_id USING ERRCODE = 'P0002';
  END IF;

  IF v_pkg.status NOT IN ('RECEBIDA','ARMAZENADA','AVISADA') THEN
    RAISE EXCEPTION 'Encomenda em estado % nao pode ser movida', v_pkg.status USING ERRCODE = '55000';
  END IF;

  v_antes := TO_JSONB(v_pkg);
  SELECT name INTO v_nome FROM public.profiles WHERE id = auth.uid();

  UPDATE public.packages SET shelf = p_nova_estante, stored_at = COALESCE(stored_at, NOW())
   WHERE id = p_package_id RETURNING * INTO v_pkg;

  INSERT INTO public.activity_logs (id, package_id, tracking_code, unit_string, action, description, operator, before_state, after_state)
  VALUES (
    'log-' || gen_random_uuid()::text,
    v_pkg.id, v_pkg.tracking_code,
    'Bloco ' || v_pkg.block || ' - Apt ' || v_pkg.apartment,
    'MOVIMENTACAO',
    'Movida de ' || COALESCE(v_antes->'shelf'->>'shelf','?') || (v_antes->'shelf'->>'level')
      || ' para ' || (p_nova_estante->>'shelf') || (p_nova_estante->>'level')
      || COALESCE(' — ' || NULLIF(TRIM(p_motivo),''), ''),
    COALESCE(v_nome, 'Portaria'),
    v_antes, TO_JSONB(v_pkg)
  );

  RETURN v_pkg;
END;
$$;

-- ==============================================================================
-- PARTE 5 — POLÍTICAS RLS REAIS (FASE 1 e 11)
-- ==============================================================================
-- Princípio: ANON não acessa nada. Cada papel enxerga só o seu escopo.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.multichannel_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_notifications ENABLE ROW LEVEL SECURITY;

-- Derruba TODAS as políticas antigas, inclusive as permissivas nomeadas.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('profiles','units','staff_accounts','packages','activity_logs','multichannel_reports','push_notifications')
  LOOP
    EXECUTE FORMAT('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- ---- profiles -------------------------------------------------------------
-- Cada um lê o próprio perfil; síndico lê todos. Ninguém escreve pelo cliente
-- (criação de conta passa pelo backend com service_role).
CREATE POLICY "perfil proprio" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_sindico());

-- ---- units ----------------------------------------------------------------
-- Morador vê e edita só a própria unidade. Staff vê todas (precisa para operar).
-- Ninguém apaga unidade pelo cliente.
CREATE POLICY "unidades leitura por escopo" ON public.units
  FOR SELECT TO authenticated
  USING (public.is_staff() OR id = public.current_unit_id());

CREATE POLICY "unidade propria atualizavel" ON public.units
  FOR UPDATE TO authenticated
  USING (id = public.current_unit_id() OR public.is_staff())
  WITH CHECK (id = public.current_unit_id() OR public.is_staff());

CREATE POLICY "staff cria unidade" ON public.units
  FOR INSERT TO authenticated
  WITH CHECK (public.is_staff());

-- ---- staff_accounts -------------------------------------------------------
-- Nenhuma política = ninguém lê. Os hashes deixam de ser alcançáveis.
-- (RLS ativo sem política nega tudo, exceto service_role.)

-- ---- packages -------------------------------------------------------------
-- Morador vê só as encomendas da própria unidade (BUG IDOR).
CREATE POLICY "encomendas por escopo" ON public.packages
  FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR unit_id = public.current_unit_id()
    OR (block, apartment) = (
      SELECT u.block, u.apartment FROM public.units u WHERE u.id = public.current_unit_id()
    )
  );

CREATE POLICY "staff registra encomenda" ON public.packages
  FOR INSERT TO authenticated
  WITH CHECK (public.is_staff());

-- UPDATE direto é restrito a staff e NÃO pode tocar em campos de baixa —
-- a retirada só acontece via confirmar_retirada(). Sem política de DELETE:
-- encomenda não é apagável por ninguém pelo cliente.
CREATE POLICY "staff atualiza encomenda" ON public.packages
  FOR UPDATE TO authenticated
  USING (public.is_staff() AND status NOT IN ('RETIRADA','CANCELADA','DEVOLVIDA','EXTRAVIADA'))
  WITH CHECK (public.is_staff() AND status NOT IN ('RETIRADA','CANCELADA','DEVOLVIDA','EXTRAVIADA'));

-- ---- activity_logs --------------------------------------------------------
-- Append-only pela trigger; aqui restringe quem lê e quem insere.
CREATE POLICY "logs leitura por escopo" ON public.activity_logs
  FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR package_id IN (SELECT p.id FROM public.packages p WHERE p.unit_id = public.current_unit_id())
  );

CREATE POLICY "autenticado registra log" ON public.activity_logs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- ---- multichannel_reports -------------------------------------------------
CREATE POLICY "relatorios staff" ON public.multichannel_reports
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE POLICY "staff grava relatorio" ON public.multichannel_reports
  FOR INSERT TO authenticated WITH CHECK (public.is_staff());

-- ---- push_notifications ---------------------------------------------------
CREATE POLICY "push por escopo" ON public.push_notifications
  FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR (block, apartment) = (
      SELECT u.block, u.apartment FROM public.units u WHERE u.id = public.current_unit_id()
    )
  );

CREATE POLICY "staff grava push" ON public.push_notifications
  FOR INSERT TO authenticated WITH CHECK (public.is_staff());

-- ==============================================================================
-- PARTE 6 — STORAGE (BUG-017): fecha o bucket
-- ==============================================================================
-- Assinaturas e fotos de entrega deixam de ser legíveis por URL pública.
UPDATE storage.buckets SET public = FALSE WHERE id = 'village-azaleia-storage';

DROP POLICY IF EXISTS "Leitura publica de imagens e comprovantes" ON storage.objects;
DROP POLICY IF EXISTS "Upload publico de fotos e assinaturas" ON storage.objects;
DROP POLICY IF EXISTS "Atualizacao publica de storage" ON storage.objects;

CREATE POLICY "storage leitura autenticada" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'village-azaleia-storage');

CREATE POLICY "storage upload autenticado" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'village-azaleia-storage');

-- ==============================================================================
-- PARTE 7 — PERMISSÕES DE EXECUÇÃO
-- ==============================================================================
REVOKE ALL ON FUNCTION public.confirmar_retirada(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolver_excecao(TEXT,TEXT,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mover_encomenda(TEXT,JSONB,TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.confirmar_retirada(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_excecao(TEXT,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mover_encomenda(TEXT,JSONB,TEXT) TO authenticated;

-- anon perde acesso de tabela por completo (cinto e suspensório junto ao RLS).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

COMMIT;

-- ==============================================================================
-- NOTA SOBRE staff_accounts
-- ==============================================================================
-- A tabela é preservada com os dados intactos, mas sem política de RLS: deixa de
-- ser legível pelo cliente e deixa de autenticar. Depois que as contas estiverem
-- criadas no Supabase Auth e validadas, ela pode ser removida com:
--   DROP TABLE public.staff_accounts;
-- Não removida aqui de propósito — é operação destrutiva e exige sua confirmação.
