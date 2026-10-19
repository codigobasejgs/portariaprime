-- ==============================================================================
-- VILLAGE AZALEIA - SCHEMA SUPABASE & STORAGE (TOTALMENTE DINÂMICO)
-- ==============================================================================
-- Execute este script no SQL Editor do seu Dashboard Supabase (https://supabase.com/dashboard)
-- Cria tabelas, índices, bucket de storage para fotos/assinaturas e Realtime.
-- ==============================================================================

-- 1. Extensões
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Tabela de Unidades / Moradores (Criadas dinamicamente conforme os moradores se cadastram)
CREATE TABLE IF NOT EXISTS public.units (
  id TEXT PRIMARY KEY, -- ex: 'B01-A101', 'B12-A802' ou alfanumérico 'B12B-A23'
  block TEXT NOT NULL,
  apartment INTEGER NOT NULL,
  resident_name TEXT NOT NULL,
  resident_phone TEXT NOT NULL,
  resident_phones JSONB NOT NULL DEFAULT '[]'::jsonb, -- Até 5 contatos WhatsApp da família
  resident_email TEXT NOT NULL,
  pwa_installed BOOLEAN DEFAULT FALSE,
  push_enabled BOOLEAN DEFAULT FALSE,
  registered_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()),
  lgpd_accepted BOOLEAN DEFAULT TRUE,
  lgpd_accepted_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()),
  password_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS units_block_apartment_idx ON public.units (block, apartment);
CREATE INDEX IF NOT EXISTS units_email_idx ON public.units (LOWER(resident_email));

-- 3. Tabela de Contas da Equipe (Portaria e Síndico)
CREATE TABLE IF NOT EXISTS public.staff_accounts (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('portaria', 'sindico')),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. Tabela de Encomendas
CREATE TABLE IF NOT EXISTS public.packages (
  id TEXT PRIMARY KEY, -- ex: 'pkg-1725148800000'
  tracking_code TEXT NOT NULL,
  unit_id TEXT REFERENCES public.units(id) ON DELETE SET NULL,
  block TEXT NOT NULL,
  apartment INTEGER NOT NULL,
  resident_name TEXT NOT NULL,
  carrier TEXT NOT NULL,
  shelf JSONB NOT NULL, -- {"shelf": "A", "level": 1}
  photo_url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ARMAZENADA' CHECK (status IN ('RECEBIDA', 'ARMAZENADA', 'RETIRADA')),
  received_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  stored_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  picked_up_by TEXT,
  operator_name TEXT,
  qr_token TEXT NOT NULL,
  registered_via TEXT NOT NULL DEFAULT 'PORTARIA' CHECK (registered_via IN ('PORTARIA', 'TOTEM_ENTREGADOR')),
  delivery_guy_name TEXT,
  dispatch_report_id TEXT,
  signature_url TEXT,
  handover_photo_url TEXT,
  receipt_protocol TEXT,
  receipt_url TEXT,
  lgpd_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS packages_unit_idx ON public.packages (block, apartment);
CREATE INDEX IF NOT EXISTS packages_status_idx ON public.packages (status);
CREATE INDEX IF NOT EXISTS packages_tracking_idx ON public.packages (tracking_code);
CREATE INDEX IF NOT EXISTS packages_qr_idx ON public.packages (qr_token);

-- 5. Tabela de Logs de Auditoria do Condomínio
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  package_id TEXT,
  tracking_code TEXT NOT NULL,
  unit_string TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  operator TEXT NOT NULL,
  details TEXT
);

CREATE INDEX IF NOT EXISTS activity_logs_timestamp_idx ON public.activity_logs (timestamp DESC);

-- 6. Tabela de Relatórios Multicanal (WhatsApp / Email / Push)
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
-- 8. HABILITAR SUPABASE REALTIME (Transmissão em tempo real)
-- ==============================================================================
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.packages; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.units; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.push_notifications; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- ==============================================================================
-- 9. POLÍTICAS DE SEGURANÇA RLS
-- ==============================================================================
ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.multichannel_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acesso publico unidades" ON public.units;
CREATE POLICY "Acesso publico unidades" ON public.units FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acesso publico staff" ON public.staff_accounts;
CREATE POLICY "Acesso publico staff" ON public.staff_accounts FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acesso publico encomendas" ON public.packages;
CREATE POLICY "Acesso publico encomendas" ON public.packages FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acesso publico logs" ON public.activity_logs;
CREATE POLICY "Acesso publico logs" ON public.activity_logs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acesso publico relatorios" ON public.multichannel_reports;
CREATE POLICY "Acesso publico relatorios" ON public.multichannel_reports FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acesso publico push" ON public.push_notifications;
CREATE POLICY "Acesso publico push" ON public.push_notifications FOR ALL USING (true) WITH CHECK (true);

-- ==============================================================================
-- 10. CRIAÇÃO DE BUCKET DO SUPABASE STORAGE PARA FOTOS E COMPROVANTES
-- ==============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'village-azaleia-storage',
  'village-azaleia-storage',
  true,
  26214400, -- 25MB por arquivo (fotos de galeria de celular sem compressão podem passar de 10MB)
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 26214400;

-- Políticas de Acesso ao Storage (Upload e Visualização Pública)
DROP POLICY IF EXISTS "Leitura publica de imagens e comprovantes" ON storage.objects;
CREATE POLICY "Leitura publica de imagens e comprovantes"
ON storage.objects FOR SELECT
USING (bucket_id = 'village-azaleia-storage');

DROP POLICY IF EXISTS "Upload publico de fotos e assinaturas" ON storage.objects;
CREATE POLICY "Upload publico de fotos e assinaturas"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'village-azaleia-storage');

DROP POLICY IF EXISTS "Atualizacao publica de storage" ON storage.objects;
CREATE POLICY "Atualizacao publica de storage"
ON storage.objects FOR UPDATE
USING (bucket_id = 'village-azaleia-storage');

-- ==============================================================================
-- 11. CONTAS PADRÃO DA EQUIPE (PORTARIA & SÍNDICO)
-- Senhas: 'portaria123' e 'sindico123'
-- ==============================================================================
INSERT INTO public.staff_accounts (id, name, email, password_hash, role)
VALUES
  ('staff-portaria-1', 'Silvio Portaria', 'portaria@villageazaleia.com.br', '6453d5df7273c2f3b949beda3dfc5b1ed29276d0d4751021159a7758b34b31a6', 'portaria'),
  ('staff-sindico-1', 'Marcos Síndico', 'sindico@villageazaleia.com.br', 'f16d085b99bbe5931a0e64018f830ec700461055f19b805d0a2cc06c3f582788', 'sindico')
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;
