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
      console.log("Received edit request body:", JSON.stringify(request.body, null, 2));
      const { id, db, name } = request.body;
      
      // Validazione dei parametri richiesti
      if (!id || !db || !name) {
        console.error("Missing required parameters:", { id, db, name });
        return reply.code(400).send({ 
          message: "Parametri mancanti. Richiesti: id, db e name", 
          received: JSON.stringify(request.body),
          status: 400 
        });
      }

      const query = `
        UPDATE categories
        SET name = $1
        WHERE id = $2 AND db = $3
        RETURNING id, name;
      `;
      const values = [name, id, db];
      console.log("Executing query with values:", values);
      
      const result = await fastify.pg.query(query, values);
      console.log("Update result:", result.rowCount, "rows affected");
      
      if (result.rowCount === 0) {
        console.warn("No rows were updated. Check if id and db values match existing records.");
        return reply.code(404).send({ 
          message: "Nessun record è stato aggiornato. Verifica che l'ID e il DB corrispondano a record esistenti.", 
          status: 404 
        });
      }

      reply.send({ message: "Categoria aggiornata correttamente", status: 200 });
    } catch (error) {
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/delete', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      console.log("Received delete request body:", JSON.stringify(request.body, null, 2));
      const { id, db } = request.body;
      
      // Validazione dei parametri richiesti
      if (!id || !db) {
        console.error("Missing required parameters:", { id, db });
        return reply.code(400).send({ 
          message: "Parametri mancanti. Richiesti: id e db", 
          received: JSON.stringify(request.body),
          status: 400 
        });
      }

      const query = 'DELETE FROM categories WHERE id = $1 AND db = $2';
      const values = [id, db];
      console.log("Executing delete query with values:", values);

      try {
        const result = await fastify.pg.query(query, values);
        console.log("Delete result:", result.rowCount, "rows affected");
        
        if (result.rowCount === 0) {
          console.warn("No rows were deleted. Check if id and db values match existing records.");
          return reply.code(404).send({ 
            message: "Nessun record è stato eliminato. Verifica che l'ID e il DB corrispondano a record esistenti.", 
            status: 404 
          });
        }
        
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
