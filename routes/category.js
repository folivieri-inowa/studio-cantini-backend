const category = async (fastify) => {
  fastify.get('/:db', { preHandler: fastify.authenticate }, async (request, reply) => {
    const db = request.params.db;

    try {
      // Fetch owners from the PostgreSQL database where db matches the input
      const categoriesQuery = `
        SELECT c.id AS id, c.name AS name, COUNT(s.id) AS subjects
        FROM categories c
        LEFT JOIN subjects s ON c.id = s.category_id
        WHERE c.db = $1
        GROUP BY c.id, c.name
        ORDER BY c.name;
      `;
      const { rows: categoriesRows } = await fastify.pg.query(categoriesQuery, [db]);

      reply.send(categoriesRows);
    } catch (error) {
      console.error(error);
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.get('/details/:id', async (request, reply) => {
    try {
      const id = request.params.id;
      try {
        const category = await Category.findOne({ _id: id });
        reply.send(category);
      } catch (error) {
        return reply.code(400).send({ message: error.message, status: 400 });
      }
    } catch (error) {
      console.error("Error fetching category", error);
      reply.status(500).send({ error: 'Failed to fetch category' });
    }
  })

  fastify.post('/create', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, name } = request.body;

      const query = `
        INSERT INTO categories (db, name)
        VALUES ($1, $2)
        RETURNING id, name;
      `;
      const values = [db, name];

      const { rows } = await fastify.pg.query(query, values);

      reply.send({ message: "Nuova categoria creata con successo", status: 200, categories: rows });
    } catch (error) {
      console.error("Error creating category", error);
      reply.status(500).send({ error: 'Failed to create category' });
    }
  });

  fastify.post('/edit', async (request, reply) => {
    try {
      const { id, db, name } = request.body;

      const query = `
        UPDATE categories
        SET name = $1
        WHERE id = $2 AND db = $3
        RETURNING id, name;
      `;
      const values = [name, id, db];
      await fastify.pg.query(query, values);

      reply.send({ message: "Categoria aggiornata correttamente", status: 200 });
    } catch (error) {
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/delete', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id, db } = request.body;

      const query = 'DELETE FROM categories WHERE id = $1 AND db = $2';
      const values = [id, db];

      try {
        await fastify.pg.query(query, values);
        reply.send({ message: "Categoria eliminata con successo", status: 200 });
      } catch (error) {
        return reply.code(400).send({ message: error.message, status: 400 });
      }
    } catch (error) {
      console.error("Error deleting category", error);
      reply.status(500).send({ message: 'Errore durante l\'eliminazione della categoria', status: 500 });
    }
  })
}

export default category;
