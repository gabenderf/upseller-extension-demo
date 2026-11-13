-- ====================================================================
-- Script de Configuração do Banco de Dados (Supabase)
-- Execute este script no SQL Editor do seu projeto Supabase.
-- ====================================================================

-- 1. Tabela: operadores_metas
-- Armazena os dados dos operadores e suas respectivas metas horárias.
CREATE TABLE IF NOT EXISTS operadores_metas (
    id_operador VARCHAR(50) PRIMARY KEY,
    nome_colaborador VARCHAR(100) NOT NULL,
    meta_horaria INTEGER NOT NULL DEFAULT 35, -- Meta padrão baseada em 35 pedidos/hora
    status VARCHAR(20) NOT NULL DEFAULT 'ativo'
);

-- RLS habilitado e configurado na Seção 5, ao final deste script.

-- 2. Tabela: pedidos_separados
-- Armazena o histórico de pedidos escaneados e enviados por bancada e operador.
CREATE TABLE IF NOT EXISTS pedidos_separados (
    id_registro BIGSERIAL PRIMARY KEY,
    id_operador VARCHAR(50) NOT NULL REFERENCES operadores_metas(id_operador) ON UPDATE CASCADE ON DELETE RESTRICT,
    data_hora TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    quantidade_pedidos INTEGER NOT NULL DEFAULT 1,
    bancada VARCHAR(50) NOT NULL,
    codigo_rastreio VARCHAR(100) UNIQUE,
    itens JSONB -- Armazena a lista de SKUs e quantidades: [{"sku": "SKU-EXEMPLO", "quantidade": 1}]
);

-- RLS habilitado e configurado na Seção 5, ao final deste script.

-- Criar índice para melhorar a performance das consultas de produtividade diária
CREATE INDEX IF NOT EXISTS idx_pedidos_operador_data ON pedidos_separados (id_operador, data_hora);

-- 2.1 num_pedido (adicionado em 18/08/2026)
--
-- Nº do pedido UpSeller ("UP209K410061"), lido da coluna "Nº de Pedido" da
-- própria tela de checkout. NÃO é usado por esta extensão nem pelo
-- dashboard: existe para o projeto ../previsao-expedicao cruzar a fila
-- pendente com o que já foi bipado.
--
-- ⚠️ Por que não bastava o codigo_rastreio: ele só nasce quando a liderança
-- processa o pedido, então pedidos na etapa "Para Enviar" não têm rastreio e
-- nunca casavam. Medido em 18/08/2026: de 102 bipagens, só 46 casavam com a
-- fila, e a fila pendente aparecia maior do que era, com o erro crescendo ao
-- longo do dia. O nº do pedido existe em TODAS as etapas.
--
-- Pode ser NULL: bipagens anteriores a esta data não têm, e se a coluna
-- sumir num deploy do UpSeller a extensão continua gravando sem ela.
ALTER TABLE pedidos_separados ADD COLUMN IF NOT EXISTS num_pedido VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_pedidos_num_pedido ON pedidos_separados (num_pedido);

-- 3. Tabela: logs_acesso
-- Registra as trocas de operadores nas bancadas com as devidas justificativas.
CREATE TABLE IF NOT EXISTS logs_acesso (
    id_log BIGSERIAL PRIMARY KEY,
    data_hora TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    bancada VARCHAR(50) NOT NULL,
    id_anterior VARCHAR(50),
    id_novo VARCHAR(50),
    justificativa VARCHAR(255) NOT NULL
);

-- RLS habilitado e configurado na Seção 5, ao final deste script.

-- ====================================================================
-- Registro Exemplo (Opcional)
-- Caso queira testar a extensão com um ID padrão imediatamente.
-- ====================================================================
INSERT INTO operadores_metas (id_operador, nome_colaborador, meta_horaria, status)
VALUES ('123', 'Operador Padrão de Teste', 35, 'ativo')
ON CONFLICT (id_operador) DO NOTHING;

-- 4. Tabela: configuracoes_gerais
-- Linha única de configurações globais controláveis remotamente pelo Dashboard.
-- Quando meta_horaria_global estiver preenchida, ela substitui a meta individual
-- (operadores_metas.meta_horaria) de TODOS os operadores até ser alterada ou removida.
CREATE TABLE IF NOT EXISTS configuracoes_gerais (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    meta_horaria_global INTEGER,
    atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT configuracoes_gerais_linha_unica CHECK (id = 1)
);

-- RLS habilitado e configurado na Seção 5, ao final deste script.

-- Garantir que a linha única de configuração sempre exista
INSERT INTO configuracoes_gerais (id, meta_horaria_global)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

-- ====================================================================
-- 5. Row Level Security (RLS)
-- Restringe cada tabela apenas às operações que a extensão e o dashboard
-- realmente usam, mesmo com a anon key exposta no código-fonte de ambos.
-- Isso NÃO impede falsificação de dados por quem tiver a anon key (não há
-- autenticação por operador), mas impede leitura/edição/exclusão fora do
-- necessário — em especial, protege o histórico (pedidos_separados e
-- logs_acesso) contra UPDATE/DELETE, que nenhum dos dois apps usa.
-- ====================================================================

-- 5.1 operadores_metas: extensão faz SELECT+INSERT; dashboard faz CRUD completo.
ALTER TABLE operadores_metas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_operadores" ON operadores_metas;
CREATE POLICY "anon_select_operadores" ON operadores_metas FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_operadores" ON operadores_metas;
CREATE POLICY "anon_insert_operadores" ON operadores_metas FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_operadores" ON operadores_metas;
CREATE POLICY "anon_update_operadores" ON operadores_metas FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_operadores" ON operadores_metas;
CREATE POLICY "anon_delete_operadores" ON operadores_metas FOR DELETE TO anon USING (true);

-- 5.2 pedidos_separados: somente leitura + inserção (histórico "append-only", nunca editado/apagado).
ALTER TABLE pedidos_separados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_pedidos" ON pedidos_separados;
CREATE POLICY "anon_select_pedidos" ON pedidos_separados FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_pedidos" ON pedidos_separados;
CREATE POLICY "anon_insert_pedidos" ON pedidos_separados FOR INSERT TO anon WITH CHECK (true);

-- 5.3 logs_acesso: somente leitura + inserção (trilha de auditoria, nunca editada/apagada).
ALTER TABLE logs_acesso ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_logs" ON logs_acesso;
CREATE POLICY "anon_select_logs" ON logs_acesso FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_logs" ON logs_acesso;
CREATE POLICY "anon_insert_logs" ON logs_acesso FOR INSERT TO anon WITH CHECK (true);

-- 5.4 configuracoes_gerais: somente leitura + atualização (linha única fixa; sem insert/delete).
ALTER TABLE configuracoes_gerais ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_config" ON configuracoes_gerais;
CREATE POLICY "anon_select_config" ON configuracoes_gerais FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_update_config" ON configuracoes_gerais;
CREATE POLICY "anon_update_config" ON configuracoes_gerais FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ====================================================================
-- 6. Tabela: usuarios_painel (login do Dashboard de Expedição)
-- Esta tabela já existe no projeto (criada fora deste script); o CREATE TABLE
-- abaixo só documenta a estrutura esperada e não altera a tabela real.
--
-- Endurecimento aplicado:
--   a) Senhas nunca mais trafegam nem ficam armazenadas em texto puro
--      (hash automático via trigger, usando pgcrypto/bcrypt).
--   b) A verificação de login roda inteiramente no banco (função
--      verificar_login_painel), então a senha (mesmo em hash) nunca
--      precisa ser lida pelo navegador para o login funcionar.
--   c) RLS bloqueia a leitura da coluna "password" por completo — mesmo
--      com a anon key, só é possível ler username/role.
-- ====================================================================
CREATE TABLE IF NOT EXISTS usuarios_painel (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    criado_em TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Garantir que a coluna comporte hashes bcrypt (60 caracteres), caso a tabela já exista com outro tipo.
ALTER TABLE usuarios_painel ALTER COLUMN password TYPE TEXT;

-- Extensão necessária para hash de senha (crypt/gen_salt).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 6.1 Hash automático: qualquer senha inserida/atualizada em texto puro é convertida em hash bcrypt.
-- Senhas que já estiverem em formato bcrypt (ex: re-execução deste script) não são re-hasheadas.
CREATE OR REPLACE FUNCTION hash_senha_painel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  IF NEW.password IS NOT NULL AND NEW.password !~ '^\$2[aby]\$' THEN
    NEW.password := crypt(NEW.password, gen_salt('bf'));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hash_senha_painel ON usuarios_painel;
CREATE TRIGGER trg_hash_senha_painel
  BEFORE INSERT OR UPDATE ON usuarios_painel
  FOR EACH ROW EXECUTE FUNCTION hash_senha_painel();

-- 6.2 Migração única: converte para hash qualquer senha que hoje esteja em texto puro.
UPDATE usuarios_painel
SET password = crypt(password, gen_salt('bf'))
WHERE password !~ '^\$2[aby]\$';

-- 6.3 Função de verificação de login: roda com privilégios elevados (SECURITY DEFINER),
-- então consegue comparar o hash internamente sem nunca devolver a senha ao chamador.
CREATE OR REPLACE FUNCTION verificar_login_painel(p_username TEXT, p_password TEXT)
RETURNS TABLE(username TEXT, role TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT u.username, u.role
  FROM usuarios_painel u
  WHERE u.username = p_username
    AND u.password = crypt(p_password, u.password);
END;
$$;

GRANT EXECUTE ON FUNCTION verificar_login_painel(TEXT, TEXT) TO anon;

-- 6.4 RLS + permissões de coluna: a senha nunca é exposta via SELECT, nem com a anon key.
ALTER TABLE usuarios_painel ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON usuarios_painel FROM anon;
GRANT SELECT (username, role), INSERT, DELETE ON usuarios_painel TO anon;

DROP POLICY IF EXISTS "anon_select_usuarios" ON usuarios_painel;
CREATE POLICY "anon_select_usuarios" ON usuarios_painel FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_usuarios" ON usuarios_painel;
CREATE POLICY "anon_insert_usuarios" ON usuarios_painel FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_usuarios" ON usuarios_painel;
CREATE POLICY "anon_delete_usuarios" ON usuarios_painel FOR DELETE TO anon USING (true);

-- Observação: INSERT/DELETE de usuários do painel continuam liberados para quem tiver a anon key
-- (mesma exposição que já existia hoje pela ausência de autenticação real por trás do botão
-- "admin"). Isso não é resolvido por RLS sozinho — exigiria login via Supabase Auth de verdade.
-- O ganho desta seção é: a senha (mesmo a de quem já está cadastrado) nunca mais é lida em
-- texto puro por ninguém, nem pelo próprio dashboard.
