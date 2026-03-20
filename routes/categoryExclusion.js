// backend/routes/categoryExclusion.js
const categoryExclusion = async (fastify) => {

  // Toggle esclusione locale per una transazione in una categoria
  fastify.post('/toggle', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, transactionId, categoryId, excluded } = request.body;

      if (!db || !transactionId || !categoryId) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      if (excluded) {
        // INSERT esclusione (ignora se già esiste)
        await fastify.pg.query(`
          INSERT INTO category_tx_exclusions (db, transaction_id, category_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (db, transaction_id, category_id) DO NOTHING
        `, [db, transactionId, categoryId]);
      } else {
        // DELETE esclusione
        await fastify.pg.query(`
          DELETE FROM category_tx_exclusions
          WHERE db = $1 AND transaction_id = $2 AND category_id = $3
        `, [db, transactionId, categoryId]);
      }

      reply.send({ success: true, excluded });
    } catch (error) {
      console.error('Error toggling category exclusion:', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // Recupera lista transaction_id escluse per una categoria e mese
  fastify.post('/list', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, categoryId, year, month } = request.body;

      if (!db || !categoryId || !year || !month) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      const { rows } = await fastify.pg.query(`
        SELECT e.transaction_id
        FROM category_tx_exclusions e
        JOIN transactions t ON t.id = e.transaction_id AND t.db = e.db
        WHERE e.db = $1
          AND e.category_id = $2
          AND EXTRACT(YEAR FROM t.date) = $3
          AND EXTRACT(MONTH FROM t.date) = $4
      `, [db, categoryId, parseInt(year, 10), parseInt(month, 10)]);

      reply.send({ excludedIds: rows.map(r => r.transaction_id) });
    } catch (error) {
      console.error('Error fetching category exclusions:', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // Ripristina tutte le esclusioni per un soggetto (e opzionalmente dettaglio) in un mese
  fastify.post('/reset', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, categoryId, subjectId, detailId, year, month } = request.body;

      if (!db || !categoryId || !subjectId || !year || !month) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      // DELETE tutte le esclusioni per le transazioni del soggetto (e dettaglio) nel mese
      if (detailId) {
        await fastify.pg.query(`
          DELETE FROM category_tx_exclusions
          WHERE db = $1
            AND category_id = $2
            AND transaction_id IN (
              SELECT t.id FROM transactions t
              WHERE t.db = $1
                AND t.subjectid = $3
                AND t.detailid = $4
                AND EXTRACT(YEAR FROM t.date) = $5
                AND EXTRACT(MONTH FROM t.date) = $6
            )
        `, [db, categoryId, subjectId, detailId, parseInt(year, 10), parseInt(month, 10)]);
      } else {
        await fastify.pg.query(`
          DELETE FROM category_tx_exclusions
          WHERE db = $1
            AND category_id = $2
            AND transaction_id IN (
              SELECT t.id FROM transactions t
              WHERE t.db = $1
                AND t.subjectid = $3
                AND EXTRACT(YEAR FROM t.date) = $4
                AND EXTRACT(MONTH FROM t.date) = $5
            )
        `, [db, categoryId, subjectId, parseInt(year, 10), parseInt(month, 10)]);
      }

      reply.send({ success: true });
    } catch (error) {
      console.error('Error resetting category exclusions:', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

};

export default categoryExclusion;
