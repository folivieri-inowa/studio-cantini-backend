// API endpoints per il sistema di learning delle classificazioni AI

const classificationFeedback = async (fastify) => {
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
