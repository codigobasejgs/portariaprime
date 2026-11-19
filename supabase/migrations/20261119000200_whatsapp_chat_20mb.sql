-- Conversas do WhatsApp no painel do síndico: anexos de até 20 MB (era 16 MB). Só o limite do bucket muda. Aditiva.
update storage.buckets set file_size_limit = 20971520 where id = 'tenant-chat';
