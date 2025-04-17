import { checkUserLogin } from '../lib/utils.js';

const owner = async (fastify) => {
  fastify.get('/:db', { preHandler: fastify.authenticate }, async (request, reply) => {
    const db = request.params.db;

    try {
      // Fetch owners from the PostgreSQL database where db matches the input
      // e rinomina il campo "date" in "balanceDate" per il frontend
      const ownersQuery = 'SELECT id, db, name, cc, iban, initialbalance as "initialBalance", "date" as "balanceDate" FROM owners WHERE db = $1';
      const { rows: ownersRows } = await fastify.pg.query(ownersQuery, [db]);

      reply.send(ownersRows);
    } catch (error) {
      console.error(error);
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/create', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, name, cc, iban, initialBalance, balanceDate } = request.body;

      const query = `
        INSERT INTO owners (db, name, cc, iban, initialbalance, "date")
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `;
      const values = [db, name, cc, iban, initialBalance || 0, balanceDate || null];

      const { rows } = await fastify.pg.query(query, values);
      const newOwner = rows[0];

      reply.send({ message: "Nuovo conto creato con successo", status: 200, owner: newOwner });
    } catch (error) {
      console.error("Error creating owner", error);
      reply.status(500).send({ error: 'Failed to create owner' });
    }
  });

  fastify.post('/edit', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id, ...updateData } = request.body;
      
      // Gestione speciale per initialBalance (case sensitive)
      if ('initialBalance' in updateData) {
        // Rinomina la chiave per adattarla al nome della colonna nel database
        updateData.initialbalance = updateData.initialBalance;
        delete updateData.initialBalance;
      }
      
      // Gestione del campo balanceDate -> date nel database
      if ('balanceDate' in updateData) {
        // Rinomina la chiave per utilizzare "date" nel database
        updateData['"date"'] = updateData.balanceDate;
        delete updateData.balanceDate;
      }

      const updateFields = Object.keys(updateData).map((key, index) => `${key} = $${index + 2}`).join(', ');
      const updateValues = Object.values(updateData);

      const query = `UPDATE owners SET ${updateFields} WHERE id = $1 RETURNING *`;
      const values = [id, ...updateValues];

      const { rows } = await fastify.pg.query(query, values);
      const updatedOwner = rows[0];

      reply.send({ message: "Conto aggiornato con successo", status: 200, owner: updatedOwner });
    } catch (error) {
      console.error("Error updating owner", error);
      reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  fastify.post('/delete', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id } = request.body;

      const query = 'DELETE FROM owners WHERE id = $1';
      const values = [id];

      try {
        await fastify.pg.query(query, values);
        reply.send({ message: "Conto corrente eliminato con successo", status: 200 });
      } catch (error) {
        return reply.code(400).send({ message: error.message, status: 400 });
      }
    } catch (error) {
      console.error("Error deleting owner", error);
      reply.status(500).send({ message: 'Errore durante l\'eliminazione del conto', status: 500 });
    }
  });
}

export default owner;
