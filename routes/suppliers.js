// routes/suppliers.js
export default async function suppliersRoutes(fastify, options) {
  const preHandler = fastify.authenticate;

  // GET /v1/suppliers/list
  fastify.post('/list', { preHandler }, async (request, reply) => {
    try {
      const { filters = {} } = request.body;
      let query = 'SELECT * FROM suppliers WHERE 1=1';
      const params = [];
      let idx = 1;

      if (filters.search) {
        params.push(`%${filters.search}%`);
        query += ` AND company_name ILIKE $${idx++}`;
      }
      if (filters.ownerId && filters.ownerId !== 'all-accounts') {
        params.push(filters.ownerId);
        query += ` AND owner_id = $${idx++}`;
      }

      query += ' ORDER BY company_name ASC';

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(query, params);
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore suppliers list:', error);
      reply.status(500).send({ error: 'Errore elenco fornitori', message: error.message });
    }
  });

  // GET /v1/suppliers/details
  fastify.post('/details', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID mancante' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query('SELECT * FROM suppliers WHERE id = $1', [id]);
        if (!result.rows.length) return reply.status(404).send({ error: 'Fornitore non trovato' });
        reply.send({ data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore suppliers details:', error);
      reply.status(500).send({ error: 'Errore dettaglio fornitore', message: error.message });
    }
  });

  // POST /v1/suppliers/create
  fastify.post('/create', { preHandler }, async (request, reply) => {
    try {
      const { company_name, iban, bank_name, payment_terms, owner_id } = request.body;
      if (!company_name) return reply.status(400).send({ error: 'Ragione sociale obbligatoria' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO suppliers (company_name, iban, bank_name, payment_terms, owner_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [company_name, iban || null, bank_name || null, payment_terms || null, owner_id || null]
        );
        reply.send({ data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore suppliers create:', error);
      reply.status(500).send({ error: 'Errore creazione fornitore', message: error.message });
    }
  });

  // POST /v1/suppliers/update
  fastify.post('/update', { preHandler }, async (request, reply) => {
    try {
      const { id, company_name, iban, bank_name, payment_terms } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID mancante' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `UPDATE suppliers
           SET company_name = COALESCE($2, company_name),
               iban = $3,
               bank_name = $4,
               payment_terms = $5,
               updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, company_name, iban ?? null, bank_name ?? null, payment_terms ?? null]
        );
        if (!result.rows.length) return reply.status(404).send({ error: 'Fornitore non trovato' });
        reply.send({ data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore suppliers update:', error);
      reply.status(500).send({ error: 'Errore aggiornamento fornitore', message: error.message });
    }
  });

  // POST /v1/suppliers/delete
  fastify.post('/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID mancante' });

      const client = await fastify.pg.pool.connect();
      try {
        // Controlla se ci sono scadenze associate
        const check = await client.query(
          'SELECT COUNT(*) as cnt FROM scadenziario WHERE supplier_id = $1', [id]
        );
        if (parseInt(check.rows[0].cnt) > 0) {
          return reply.status(409).send({
            error: 'Impossibile eliminare',
            message: `Il fornitore ha ${check.rows[0].cnt} fatture associate`
          });
        }

        const result = await client.query(
          'DELETE FROM suppliers WHERE id = $1 RETURNING id', [id]
        );
        if (!result.rows.length) return reply.status(404).send({ error: 'Fornitore non trovato' });
        reply.send({ data: { id: result.rows[0].id, deleted: true } });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore suppliers delete:', error);
      reply.status(500).send({ error: 'Errore eliminazione fornitore', message: error.message });
    }
  });
}
