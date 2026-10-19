-- ==============================================================================
-- VILLAGE AZALEIA - SCHEMA SUPABASE & STORAGE (SEGURO E CONFORME LGPD)
-- ==============================================================================
-- Execute este script no SQL Editor do seu Dashboard Supabase (https://supabase.com/dashboard)
-- Cria tabelas com RLS real, funcoes de retirada atomica e triggers de auditoria imutavel.
-- ==============================================================================

-- 1. Extensoes
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Tabela de Unidades / Moradores
CREATE TABLE IF NOT EXISTS public.units (
  id TEXT PRIMARY KEY, -- ex: 'B01-A101', 'B12-A802', 'B12B-A23'
  block TEXT NOT NULL,
  apartment INTEGER NOT NULL CHECK (apartment > 0),
  resident_name TEXT NOT NULL,
  resident_phone TEXT NOT NULL,
  resident_phones JSONB NOT NULL DEFAULT '[]'::jsonb,
  resident_email TEXT NOT NULL,
  pwa_installed BOOLEAN DEFAULT FALSE,
  push_enabled BOOLEAN DEFAULT FALSE,
  registered_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()),
  lgpd_accepted BOOLEAN DEFAULT FALSE,
  lgpd_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS units_block_apartment_idx ON public.units (block, apartment);
CREATE INDEX IF NOT EXISTS units_email_idx ON public.units (LOWER(resident_email));

-- 3. Tabela de Perfis ancorados em auth.users (substitui staff_accounts)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('portaria', 'sindico', 'morador', 'totem')),
  name TEXT NOT NULL,
  unit_id TEXT REFERENCES public.units(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles (role);
CREATE INDEX IF NOT EXISTS profiles_unit_idx ON public.profiles (unit_id);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_unit_unico_idx
  ON public.profiles (unit_id)
  WHERE unit_id IS NOT NULL AND role = 'morador';

-- 4. Tabela de Encomendas
CREATE TABLE IF NOT EXISTS public.packages (
  id TEXT PRIMARY KEY, -- ex: 'pkg-<uuid>'
  tracking_code TEXT NOT NULL,
  unit_id TEXT REFERENCES public.units(id) ON DELETE RESTRICT,
  block TEXT NOT NULL,
  apartment INTEGER NOT NULL,
  resident_name TEXT NOT NULL,
  carrier TEXT NOT NULL,
  shelf JSONB NOT NULL,
  photo_url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ARMAZENADA'
    CHECK (status IN ('RECEBIDA','ARMAZENADA','AVISADA','RETIRADA','CANCELADA','DEVOLVIDA','EXTRAVIADA')),
  received_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  stored_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  picked_up_by TEXT,
  operator_name TEXT,
  qr_token TEXT NOT NULL,
  qr_expires_at TIMESTAMPTZ,
  qr_consumed_at TIMESTAMPTZ,
  registered_via TEXT NOT NULL DEFAULT 'PORTARIA' CHECK (registered_via IN ('PORTARIA', 'TOTEM_ENTREGADOR')),
  delivery_guy_name TEXT,
  dispatch_report_id TEXT,
  signature_url TEXT,
  handover_photo_url TEXT,
  receipt_protocol TEXT,
  receipt_url TEXT,
  resolution_reason TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  lgpd_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  CONSTRAINT packages_retirada_completa_check CHECK (
    status <> 'RETIRADA' OR (picked_up_at IS NOT NULL AND picked_up_by IS NOT NULL AND LENGTH(TRIM(picked_up_by)) > 0)
  ),
  CONSTRAINT packages_excecao_justificada_check CHECK (
    status NOT IN ('CANCELADA','DEVOLVIDA','EXTRAVIADA')
    OR (resolution_reason IS NOT NULL AND LENGTH(TRIM(resolution_reason)) >= 10 AND resolved_by IS NOT NULL)
  ),
  CONSTRAINT packages_ordem_temporal_check CHECK (
    picked_up_at IS NULL OR picked_up_at >= received_at
  )
);

CREATE INDEX IF NOT EXISTS packages_unit_idx ON public.packages (block, apartment);
CREATE INDEX IF NOT EXISTS packages_status_idx ON public.packages (status);
CREATE UNIQUE INDEX IF NOT EXISTS packages_tracking_ativo_idx
  ON public.packages (tracking_code)
  WHERE status IN ('RECEBIDA', 'ARMAZENADA', 'AVISADA');
CREATE UNIQUE INDEX IF NOT EXISTS packages_qr_token_unico_idx ON public.packages (qr_token);

-- 5. Tabela de Logs de Auditoria (Append-only e imutavel)
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  package_id TEXT,
  tracking_code TEXT NOT NULL,
  unit_string TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  operator TEXT NOT NULL,
  details TEXT,
  before_state JSONB,
  after_state JSONB
);

CREATE INDEX IF NOT EXISTS activity_logs_timestamp_idx ON public.activity_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS activity_logs_package_idx ON public.activity_logs (package_id);

-- 6. Tabela de Relatórios Multicanal
CREATE TABLE IF NOT EXISTS public.multichannel_reports (
  id TEXT PRIMARY KEY,
  package_id TEXT,
  tracking_code TEXT NOT NULL,
  unit_string TEXT NOT NULL,
  resident_name TEXT NOT NULL,
  carrier TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  whatsapp_dispatches JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_dispatch JSONB NOT NULL DEFAULT '{}'::jsonb,
  web_push_dispatch JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 7. Tabela de Notificações Push
CREATE TABLE IF NOT EXISTS public.push_notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  package_id TEXT,
  block TEXT NOT NULL,
  apartment INTEGER NOT NULL,
  resident_name TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking_code TEXT NOT NULL,
  shelf_string TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  read BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS push_notifications_unit_idx ON public.push_notifications (block, apartment);

-- ==============================================================================
-- 8. TRIGGERS DE AUDITORIA IMUTÁVEL
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.bloquear_alteracao_de_log()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_logs e append-only: % bloqueado por politica de auditoria', TG_OP;
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

CREATE OR REPLACE FUNCTION public.carimbar_log()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
-- 9. FUNÇÕES DE OPERAÇÃO ATÔMICA
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.current_role_name()
RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() AND active LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.current_role_name() IN ('portaria', 'sindico', 'totem'), FALSE);
$$;

CREATE OR REPLACE FUNCTION public.is_sindico()
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.current_role_name() = 'sindico', FALSE);
$$;

CREATE OR REPLACE FUNCTION public.current_unit_id()
RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT unit_id FROM public.profiles WHERE id = auth.uid() AND active LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.confirmar_retirada(
  p_package_id TEXT,
  p_qr_token TEXT,
  p_picked_up_by TEXT,
  p_signature_url TEXT,
  p_handover_photo_url TEXT DEFAULT NULL,
  p_receipt_protocol TEXT DEFAULT NULL
)
RETURNS public.packages LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pkg public.packages;
  v_antes JSONB;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Sem permissao para dar baixa em encomenda' USING ERRCODE = '42501';
  END IF;

  IF p_picked_up_by IS NULL OR LENGTH(TRIM(p_picked_up_by)) = 0 THEN
    RAISE EXCEPTION 'Informe quem esta retirando a encomenda' USING ERRCODE = '22023';
  END IF;

  IF p_signature_url IS NULL OR LENGTH(TRIM(p_signature_url)) = 0 THEN
    RAISE EXCEPTION 'Assinatura digital e obrigatoria para a baixa' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_pkg FROM public.packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encomenda % nao encontrada', p_package_id USING ERRCODE = 'P0002';
  END IF;

  IF v_pkg.status = 'RETIRADA' THEN
    RAISE EXCEPTION 'Encomenda ja foi retirada por % em %',
      COALESCE(v_pkg.picked_up_by, 'desconhecido'),
      TO_CHAR(v_pkg.picked_up_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      USING ERRCODE = '55000';
  END IF;

  IF v_pkg.status IN ('CANCELADA','DEVOLVIDA','EXTRAVIADA') THEN
    RAISE EXCEPTION 'Encomenda esta como % e nao pode ser entregue', v_pkg.status USING ERRCODE = '55000';
  END IF;

  IF p_qr_token IS NOT NULL AND LENGTH(TRIM(p_qr_token)) > 0 THEN
    IF v_pkg.qr_token <> p_qr_token THEN
      RAISE EXCEPTION 'QR Code nao corresponde a esta encomenda' USING ERRCODE = '22023';
    END IF;
    IF v_pkg.qr_consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'QR Code ja utilizado em %',
        TO_CHAR(v_pkg.qr_consumed_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
        USING ERRCODE = '55000';
    END IF;
    IF v_pkg.qr_expires_at IS NOT NULL AND v_pkg.qr_expires_at < NOW() THEN
      RAISE EXCEPTION 'QR Code expirado' USING ERRCODE = '55000';
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
     AND status IN ('RECEBIDA','ARMAZENADA','AVISADA')
   RETURNING * INTO v_pkg;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Baixa nao aplicada: estado alterado por outra transacao' USING ERRCODE = '55000';
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

CREATE OR REPLACE FUNCTION public.resolver_excecao(
  p_package_id TEXT, p_novo_status TEXT, p_motivo TEXT
)
RETURNS public.packages LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pkg public.packages;
  v_antes JSONB;
  v_nome TEXT;
BEGIN
  IF NOT public.is_sindico() THEN
    RAISE EXCEPTION 'Apenas o sindico pode registrar excecao' USING ERRCODE = '42501';
  END IF;

  IF p_novo_status NOT IN ('CANCELADA','DEVOLVIDA','EXTRAVIADA') THEN
    RAISE EXCEPTION 'Status invalido' USING ERRCODE = '22023';
  END IF;

  IF p_motivo IS NULL OR LENGTH(TRIM(p_motivo)) < 10 THEN
    RAISE EXCEPTION 'Descreva o motivo com pelo menos 10 caracteres' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_pkg FROM public.packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encomenda nao encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_pkg.status = 'RETIRADA' THEN
    RAISE EXCEPTION 'Encomenda ja entregue' USING ERRCODE = '55000';
  END IF;

  v_antes := TO_JSONB(v_pkg);
  SELECT name INTO v_nome FROM public.profiles WHERE id = auth.uid();

  UPDATE public.packages
     SET status = p_novo_status, resolution_reason = TRIM(p_motivo), resolved_at = NOW(), resolved_by = COALESCE(v_nome, 'Sindico')
   WHERE id = p_package_id RETURNING * INTO v_pkg;

  INSERT INTO public.activity_logs (id, package_id, tracking_code, unit_string, action, description, operator, before_state, after_state)
  VALUES (
    'log-' || gen_random_uuid()::text, v_pkg.id, v_pkg.tracking_code,
    'Bloco ' || v_pkg.block || ' - Apt ' || v_pkg.apartment, 'EXCECAO',
    p_novo_status || ': ' || TRIM(p_motivo), COALESCE(v_nome, 'Sindico'), v_antes, TO_JSONB(v_pkg)
  );

  RETURN v_pkg;
END;
$$;

CREATE OR REPLACE FUNCTION public.mover_encomenda(
  p_package_id TEXT, p_nova_estante JSONB, p_motivo TEXT DEFAULT NULL
)
RETURNS public.packages LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pkg public.packages;
  v_antes JSONB;
  v_nome TEXT;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Sem permissao' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pkg FROM public.packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Encomenda nao encontrada' USING ERRCODE = 'P0002'; END IF;
  IF v_pkg.status NOT IN ('RECEBIDA','ARMAZENADA','AVISADA') THEN
    RAISE EXCEPTION 'Encomenda nao pode ser movida' USING ERRCODE = '55000';
  END IF;

  v_antes := TO_JSONB(v_pkg);
  SELECT name INTO v_nome FROM public.profiles WHERE id = auth.uid();

  UPDATE public.packages SET shelf = p_nova_estante, stored_at = COALESCE(stored_at, NOW())
   WHERE id = p_package_id RETURNING * INTO v_pkg;

  INSERT INTO public.activity_logs (id, package_id, tracking_code, unit_string, action, description, operator, before_state, after_state)
  VALUES (
    'log-' || gen_random_uuid()::text, v_pkg.id, v_pkg.tracking_code,
    'Bloco ' || v_pkg.block || ' - Apt ' || v_pkg.apartment, 'MOVIMENTACAO',
    'Movida para ' || (p_nova_estante->>'shelf') || (p_nova_estante->>'level'),
    COALESCE(v_nome, 'Portaria'), v_antes, TO_JSONB(v_pkg)
  );

  RETURN v_pkg;
END;
$$;

-- ==============================================================================
-- 10. HABILITAR SUPABASE REALTIME
-- ==============================================================================
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.packages; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.units; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.push_notifications; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- ==============================================================================
-- 11. POLÍTICAS RLS (ANON = BLOQUEIO TOTAL; CADA PAPEL NO SEU ESCOPO)
-- ==============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.multichannel_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "perfil proprio" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_sindico());

CREATE POLICY "unidades leitura por escopo" ON public.units FOR SELECT TO authenticated
  USING (public.is_staff() OR id = public.current_unit_id());

CREATE POLICY "unidade propria atualizavel" ON public.units FOR UPDATE TO authenticated
  USING (id = public.current_unit_id() OR public.is_staff())
  WITH CHECK (id = public.current_unit_id() OR public.is_staff());

CREATE POLICY "staff cria unidade" ON public.units FOR INSERT TO authenticated
  WITH CHECK (public.is_staff());

CREATE POLICY "encomendas por escopo" ON public.packages FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR unit_id = public.current_unit_id()
    OR (block, apartment) = (SELECT u.block, u.apartment FROM public.units u WHERE u.id = public.current_unit_id())
  );

CREATE POLICY "staff registra encomenda" ON public.packages FOR INSERT TO authenticated
  WITH CHECK (public.is_staff());

CREATE POLICY "staff atualiza encomenda" ON public.packages FOR UPDATE TO authenticated
  USING (public.is_staff() AND status NOT IN ('RETIRADA','CANCELADA','DEVOLVIDA','EXTRAVIADA'))
  WITH CHECK (public.is_staff() AND status NOT IN ('RETIRADA','CANCELADA','DEVOLVIDA','EXTRAVIADA'));

CREATE POLICY "logs leitura por escopo" ON public.activity_logs FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR package_id IN (SELECT p.id FROM public.packages p WHERE p.unit_id = public.current_unit_id())
  );

CREATE POLICY "autenticado registra log" ON public.activity_logs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "relatorios staff" ON public.multichannel_reports FOR SELECT TO authenticated
  USING (public.is_staff());

CREATE POLICY "staff grava relatorio" ON public.multichannel_reports FOR INSERT TO authenticated
  WITH CHECK (public.is_staff());

CREATE POLICY "push por escopo" ON public.push_notifications FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR (block, apartment) = (SELECT u.block, u.apartment FROM public.units u WHERE u.id = public.current_unit_id())
  );

CREATE POLICY "staff grava push" ON public.push_notifications FOR INSERT TO authenticated
  WITH CHECK (public.is_staff());

-- ==============================================================================
-- 12. STORAGE FECHADO (ASSINATURAS PROTEGIDAS)
-- ==============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'village-azaleia-storage', 'village-azaleia-storage', false, 26214400,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 26214400;

DROP POLICY IF EXISTS "storage leitura autenticada" ON storage.objects;
CREATE POLICY "storage leitura autenticada" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'village-azaleia-storage');

DROP POLICY IF EXISTS "storage upload autenticado" ON storage.objects;
CREATE POLICY "storage upload autenticado" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'village-azaleia-storage');

-- Permissoes
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT EXECUTE ON FUNCTION public.confirmar_retirada TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_excecao TO authenticated;
GRANT EXECUTE ON FUNCTION public.mover_encomenda TO authenticated;
