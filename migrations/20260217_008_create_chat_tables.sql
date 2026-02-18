-- Migration: Create chat tables for conversational archive assistant
-- Created: 2026-02-17
-- Description: Tabelle per gestire sessioni di chat e messaggi con memoria conversazionale

-- Tabella sessioni chat
CREATE TABLE IF NOT EXISTS archive_chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    db VARCHAR(50) NOT NULL,
    user_id VARCHAR(100), -- per futuro multi-user
    title VARCHAR(255), -- titolo auto-generato o impostato dall'utente
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB -- per eventuali dati aggiuntivi (es. documenti referenziati)
);

-- Tabella messaggi chat
CREATE TABLE IF NOT EXISTS archive_chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES archive_chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    sources JSONB, -- array di documenti/fonti usate per la risposta
    tokens_used INTEGER, -- per monitoraggio costi
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB -- per debug, timing, etc.
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_chat_sessions_db ON archive_chat_sessions(db);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON archive_chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_active ON archive_chat_sessions(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON archive_chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON archive_chat_messages(session_id, created_at);

-- Trigger per updated_at automatico
CREATE OR REPLACE FUNCTION update_chat_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_chat_session ON archive_chat_sessions;
CREATE TRIGGER trigger_update_chat_session
    BEFORE UPDATE ON archive_chat_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_chat_session_timestamp();

-- Commenti
COMMENT ON TABLE archive_chat_sessions IS 'Sessioni di chat con l assistente documentale';
COMMENT ON TABLE archive_chat_messages IS 'Messaggi delle sessioni chat';
COMMENT ON COLUMN archive_chat_messages.sources IS 'Documenti/fonti usate per generare la risposta (RAG)';
COMMENT ON COLUMN archive_chat_messages.tokens_used IS 'Token consumati per la risposta LLM';
