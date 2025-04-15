import { checkUserLogin } from '../lib/utils.js';

const detail = async (fastify) => {
  fastify.post('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db, subjectId } = request.body;

    try {
      const detailsQuery = `
        SELECT id, name
        FROM details 
        WHERE db = $1 AND subject_id = $2
      `;
      const { rows: detailsRows } = await fastify.pg.query(detailsQuery, [db, subjectId]);

      reply.send(detailsRows);
    } catch (error) {
      console.error(error);
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/create', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, name, subjectId } = request.body;

      const user = await checkUserLogin(fastify, request.headers.authorization);
      if (!user) {
        return reply.code(401).send({ message: 'Unauthorized', status: 401 });
      }

      const query = `
        INSERT INTO details (db, name, subject_id)
        VALUES ($1, $2, $3)
        RETURNING id, name;
      `;
      const values = [db, name, subjectId];

      const { rows } = await fastify.pg.query(query, values);

      reply.send({ message: "Nuovo soggetto creato con successo", status: 200, detail: rows });
    } catch (error) {
      console.error("Error creating subject", error);
      reply.status(500).send({ error: 'Failed to create subject' });
    }
  });

  fastify.post('/edit', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id, db, name } = request.body;

      const query = `
        UPDATE details
        SET name = $1
        WHERE id = $2 AND db = $3
        RETURNING id, name;
      `;
      const values = [name, id, db];
      await fastify.pg.query(query, values);

      reply.send({ message: "Dettaglio aggiornata correttamente", status: 200 });
    } catch (error) {
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/delete', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id, db } = request.body;

      const query = 'DELETE FROM details WHERE id = $1 AND db = $2';
      const values = [id, db];

      try {
        await fastify.pg.query(query, values);
        reply.send({ message: "Dettaglio eliminato con successo", status: 200 });
      } catch (error) {
        return reply.code(400).send({ message: error.message, status: 400 });
      }
    } catch (error) {
      console.error("Error deleting subject", error);
      reply.status(500).send({ message: 'Errore durante l\'eliminazione del dettaglio', status: 500 });
    }
  })
}

export default detail;
