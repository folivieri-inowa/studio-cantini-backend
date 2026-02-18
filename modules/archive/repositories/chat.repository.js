/**
 * Repository per gestione chat conversazionale
 * Gestisce sessioni e messaggi con memoria
 */
class ChatRepository {
  constructor(pg) {
    this.pg = pg;
  }

  /**
   * Crea una nuova sessione di chat
   */
  async createSession(db, userId = null, title = null) {
    const query = `
      INSERT INTO archive_chat_sessions (db, user_id, title)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const result = await this.pg.query(query, [db, userId, title || 'Nuova conversazione']);
    return result.rows[0];
  }

  /**
   * Trova una sessione per ID
   */
  async findSessionById(sessionId) {
    const query = `SELECT * FROM archive_chat_sessions WHERE id = $1`;
    const result = await this.pg.query(query, [sessionId]);
    return result.rows[0] || null;
  }

  /**
   * Lista sessioni attive per database
   */
  async listSessions(db, limit = 20) {
    const query = `
      SELECT s.*,
        (SELECT content FROM archive_chat_messages
         WHERE session_id = s.id AND role = 'user'
         ORDER BY created_at DESC LIMIT 1) as last_message_preview
      FROM archive_chat_sessions s
      WHERE s.db = $1 AND s.is_active = true
      ORDER BY s.last_message_at DESC
      LIMIT $2
    `;
    const result = await this.pg.query(query, [db, limit]);
    return result.rows;
  }

  /**
   * Aggiorna timestamp ultimo messaggio
   */
  async updateLastMessageTime(sessionId) {
    const query = `
      UPDATE archive_chat_sessions
      SET last_message_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    await this.pg.query(query, [sessionId]);
  }

  /**
   * Archivia (soft delete) una sessione
   */
  async archiveSession(sessionId) {
    const query = `
      UPDATE archive_chat_sessions
      SET is_active = false
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [sessionId]);
    return result.rows[0];
  }

  /**
   * Aggiorna titolo sessione
   */
  async updateSessionTitle(sessionId, title) {
    const query = `
      UPDATE archive_chat_sessions
      SET title = $2
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [sessionId, title]);
    return result.rows[0];
  }

  /**
   * Salva un messaggio
   */
  async saveMessage(sessionId, role, content, sources = null, tokensUsed = null) {
    const query = `
      INSERT INTO archive_chat_messages (session_id, role, content, sources, tokens_used)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await this.pg.query(query, [
      sessionId,
      role,
      content,
      sources ? JSON.stringify(sources) : null,
      tokensUsed
    ]);

    // Aggiorna timestamp sessione
    await this.updateLastMessageTime(sessionId);

    return result.rows[0];
  }

  /**
   * Recupera storico messaggi di una sessione (per contesto LLM)
   * @param {number} maxMessages - Numero massimo di messaggi da recuperare (default 10)
   */
  async getSessionHistory(sessionId, maxMessages = 10) {
    const query = `
      SELECT role, content, sources, created_at
      FROM archive_chat_messages
      WHERE session_id = $1
      ORDER BY created_at ASC
      LIMIT $2
    `;
    const result = await this.pg.query(query, [sessionId, maxMessages]);
    return result.rows;
  }

  /**
   * Recupera ultimi N messaggi (per contesto immediato)
   * @param {number} limit - Numero di messaggi recenti (default 6 = 3 scambi)
   */
  async getRecentMessages(sessionId, limit = 6) {
    const query = `
      SELECT role, content, sources
      FROM archive_chat_messages
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await this.pg.query(query, [sessionId, limit]);
    // Inverti per avere ordine cronologico
    return result.rows.reverse();
  }

  /**
   * Elimina tutti i messaggi di una sessione
   */
  async clearSessionMessages(sessionId) {
    const query = `DELETE FROM archive_chat_messages WHERE session_id = $1`;
    await this.pg.query(query, [sessionId]);
  }

  /**
   * Elimina completamente una sessione e i suoi messaggi
   */
  async deleteSession(sessionId) {
    // I messaggi verranno eliminati automaticamente per ON DELETE CASCADE
    const query = `DELETE FROM archive_chat_sessions WHERE id = $1 RETURNING *`;
    const result = await this.pg.query(query, [sessionId]);
    return result.rows[0];
  }

  /**
   * Conta messaggi in una sessione
   */
  async countMessages(sessionId) {
    const query = `SELECT COUNT(*) as count FROM archive_chat_messages WHERE session_id = $1`;
    const result = await this.pg.query(query, [sessionId]);
    return parseInt(result.rows[0].count, 10);
  }
}

export default ChatRepository;
