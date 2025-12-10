// API endpoints per il sistema di learning delle classificazioni AI

const classificationFeedback = async (fastify) => {
  // Cerca il miglior match considerando descrizione E importo
  fastify.post('/find-best-match', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db, description, amount } = request.body;

    if (!description) {
      return reply.code(400).send({ message: 'Description required', status: 400 });
    }

    try {
      // Query avanzata che combina similarity testuale con proximity di importo
      // L'idea: EDISON 500€ → Villa Allemandi, EDISON 60€ → Al Gualdo
      const query = `
        WITH scored_feedback AS (
          SELECT 
            cf.id,
            cf.original_description,
            cf.amount as feedback_amount,
            cf.corrected_category_id,
            cf.corrected_subject_id,
            cf.corrected_detail_id,
            c.name as category_name,
            s.name as subject_name,
            d.name as detail_name,
            -- Similarity testuale (0-1)
            similarity(cf.original_description, $2) as text_similarity,
            -- Proximity di importo (0-1): quanto è simile l'importo?
            -- Usa rapporto logaritmico per gestire scale diverse
            CASE 
              WHEN cf.amount IS NULL OR $3::numeric IS NULL THEN 0.5
              WHEN ABS(cf.amount) < 1 OR ABS($3::numeric) < 1 THEN 0.5
              ELSE 1.0 - LEAST(1.0, ABS(LN(ABS(cf.amount)) - LN(ABS($3::numeric))) / 3.0)
            END as amount_proximity,
            -- Score combinato: 70% testo + 30% importo
            -- Questo permette di distinguere stesso operatore con importi diversi
            (similarity(cf.original_description, $2) * 0.7 + 
             CASE 
               WHEN cf.amount IS NULL OR $3::numeric IS NULL THEN 0.5
               WHEN ABS(cf.amount) < 1 OR ABS($3::numeric) < 1 THEN 0.5
               ELSE 1.0 - LEAST(1.0, ABS(LN(ABS(cf.amount)) - LN(ABS($3::numeric))) / 3.0)
             END * 0.3) as combined_score
          FROM classification_feedback cf
          JOIN categories c ON cf.corrected_category_id = c.id
          JOIN subjects s ON cf.corrected_subject_id = s.id
          LEFT JOIN details d ON cf.corrected_detail_id = d.id
          WHERE cf.db = $1
            AND similarity(cf.original_description, $2) > 0.5  -- Pre-filter per performance
        )
        SELECT 
          *,
          'feedback_learning' as method
        FROM scored_feedback
        WHERE combined_score >= 0.6  -- Threshold minimo
        ORDER BY combined_score DESC
        LIMIT 1
      `;

      const result = await fastify.pg[db].query(query, [db, description, amount || 0]);

      if (result.rows.length === 0) {
        return reply.code(200).send({
          data: null,
          match_found: false,
          status: 200
        });
      }

      const match = result.rows[0];
      return reply.code(200).send({
        data: {
          category_id: match.corrected_category_id,
          category_name: match.category_name,
          subject_id: match.corrected_subject_id,
          subject_name: match.subject_name,
          detail_id: match.corrected_detail_id,
          detail_name: match.detail_name,
          confidence: Math.round(match.combined_score * 100),
          text_similarity: Math.round(match.text_similarity * 100),
          amount_proximity: Math.round(match.amount_proximity * 100),
          matched_description: match.original_description,
          matched_amount: match.feedback_amount,
          method: 'feedback_learning_v2'
        },
        match_found: true,
        status: 200
      });
    } catch (error) {
      console.error('Error finding best match:', error);
      return reply.code(400).send({
        message: error.message,
        status: 400
      });
    }
  });

  // Ottieni feedback storici per migliorare le classificazioni
  fastify.post('/learning-data', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db, description, limit = 100 } = request.body;

    try {
      // Cerca feedback simili alla descrizione fornita usando full-text search
      const query = `
        SELECT 
          cf.id,
          cf.original_description,
          cf.amount,
          cf.transaction_date,
          cf.corrected_category_id,
          cf.corrected_subject_id,
          cf.corrected_detail_id,
          c.name as category_name,
          s.name as subject_name,
          d.name as detail_name,
          cf.suggestion_confidence,
          cf.created_at,
          -- Calcola similarità con la descrizione di input
          similarity(cf.original_description, $2) as similarity_score
        FROM classification_feedback cf
        JOIN categories c ON cf.corrected_category_id = c.id
        JOIN subjects s ON cf.corrected_subject_id = s.id
        LEFT JOIN details d ON cf.corrected_detail_id = d.id
        WHERE cf.db = $1
          AND similarity(cf.original_description, $2) > 0.3
        ORDER BY similarity_score DESC, cf.created_at DESC
        LIMIT $3
      `;

      const result = await fastify.pg[db].query(query, [db, description, limit]);

      return reply.code(200).send({
        data: result.rows,
        count: result.rows.length,
        status: 200
      });
    } catch (error) {
      console.error('Error fetching learning data:', error);
      return reply.code(400).send({
        message: error.message,
        status: 400
      });
    }
  });

  // Statistiche sul feedback per monitoraggio
  fastify.get('/stats/:db', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db } = request.params;

    try {
      const query = `
        SELECT 
          COUNT(*) as total_feedbacks,
          COUNT(DISTINCT transaction_id) as unique_transactions,
          AVG(suggestion_confidence) as avg_original_confidence,
          COUNT(*) FILTER (WHERE suggestion_confidence >= 90) as high_confidence_corrections,
          COUNT(*) FILTER (WHERE suggestion_confidence < 70) as low_confidence_corrections,
          COUNT(DISTINCT corrected_category_id) as categories_involved,
          COUNT(DISTINCT corrected_subject_id) as subjects_involved,
          DATE_TRUNC('day', MIN(created_at)) as first_feedback_date,
          DATE_TRUNC('day', MAX(created_at)) as last_feedback_date
        FROM classification_feedback
        WHERE db = $1
      `;

      const result = await fastify.pg[db].query(query, [db]);

      return reply.code(200).send({
        data: result.rows[0],
        status: 200
      });
    } catch (error) {
      console.error('Error fetching feedback stats:', error);
      return reply.code(400).send({
        message: error.message,
        status: 400
      });
    }
  });
};

export default classificationFeedback;
