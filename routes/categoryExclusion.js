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

};

export default categoryExclusion;
