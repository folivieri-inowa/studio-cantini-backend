import { checkUserLogin } from '../lib/utils.js';

const subject = async (fastify) => {
  fastify.get('/:db', { preHandler: fastify.authenticate }, async (request, reply) => {
    const db = request.params.db;

    try {
      const subjectsQuery = `
        SELECT s.id AS id, s.name AS name, COUNT(d.id) AS details
        FROM subjects s
        LEFT JOIN details d ON s.id = d.subject_id
        WHERE s.db = $1
        GROUP BY s.id, s.name
        ORDER BY s.name;
      `;
      const { rows: subjectsRows } = await fastify.pg.query(subjectsQuery, [db]);

      reply.send(subjectsRows);
    } catch (error) {
      console.error(error);
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db, categoryId } = request.body;

    try {
      const subjectsQuery = `
        SELECT s.id AS id, s.name AS name, COUNT(d.id) AS details
        FROM subjects s
        LEFT JOIN details d ON s.id = d.subject_id
        WHERE s.db = $1 AND s.category_id = $2
        GROUP BY s.id, s.name
        ORDER BY s.name;
      `;
      const { rows: subjectsRows } = await fastify.pg.query(subjectsQuery, [db, categoryId]);

      reply.send(subjectsRows);
    } catch (error) {
      console.error(error);
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/create', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, name, categoryId } = request.body;

      const query = `
        INSERT INTO subjects (db, name, category_id)
        VALUES ($1, $2, $3)
        RETURNING id, name;
      `;
      const values = [db, name, categoryId];

      const { rows } = await fastify.pg.query(query, values);

      reply.send({ message: "Nuovo soggetto creato con successo", status: 200, subject: rows });
    } catch (error) {
      console.error("Error creating subject", error);
      reply.status(500).send({ error: 'Failed to create subject' });
    }
  });

  fastify.post('/edit', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id, db, name } = request.body;

      const query = `
        UPDATE subjects
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

      const query = 'DELETE FROM subjects WHERE id = $1 AND db = $2';
      const values = [id, db];

      try {
        await fastify.pg.query(query, values);
        reply.send({ message: "Soggetto eliminato con successo", status: 200 });
      } catch (error) {
        return reply.code(400).send({ message: error.message, status: 400 });
      }
    } catch (error) {
      console.error("Error deleting subject", error);
      reply.status(500).send({ message: 'Errore durante l\'eliminazione del soggetto', status: 500 });
    }
  })
}

export default subject;
