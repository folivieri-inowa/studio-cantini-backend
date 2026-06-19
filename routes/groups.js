/**
 * Groups Routes for Fastify
 * Simplified — category-only grouping (no subjects, no description, no user_id)
 */

async function groupsRoutes(fastify, options) {
  // GET / — list all groups for a db
  fastify.get('/', async (request, reply) => {
    try {
      const { db } = request.query;
      if (!db) return reply.status(400).send({ error: 'Database parameter is required' });

      const query = `
        SELECT g.id, g.name, g.db, g.created_at, g.updated_at,
               COUNT(gi.id)::int AS items_count
        FROM groups g
        LEFT JOIN group_items gi ON g.id = gi.group_id
        WHERE g.db = $1
        GROUP BY g.id
        ORDER BY g.name ASC
      `;
      const result = await fastify.pg.query(query, [db]);
      reply.send({ success: true, data: result.rows });
    } catch (error) {
      console.error('Error fetching groups:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:id — single group with items
  fastify.get('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db } = request.query;
      if (!db) return reply.status(400).send({ error: 'Database parameter is required' });

      const groupResult = await fastify.pg.query(
        'SELECT id, name, db, created_at, updated_at FROM groups WHERE id = $1 AND db = $2',
        [id, db]
      );
      if (groupResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Group not found' });
      }

      const itemsResult = await fastify.pg.query(
        `SELECT gi.id, gi.category_id, c.name AS category_name
         FROM group_items gi
         LEFT JOIN categories c ON gi.category_id = c.id
         WHERE gi.group_id = $1
         ORDER BY c.name ASC`,
        [id]
      );

      const group = groupResult.rows[0];
      group.items = itemsResult.rows;
      reply.send({ success: true, data: group });
    } catch (error) {
      console.error('Error fetching group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST / — create group
  fastify.post('/', async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { name, db, items = [] } = request.body;
      if (!name || !db) {
        return reply.status(400).send({ error: 'Name and database are required' });
      }

      await client.query('BEGIN');

      // Check uniqueness per db
      const existing = await client.query(
        'SELECT id FROM groups WHERE name = $1 AND db = $2', [name, db]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: 'Un gruppo con questo nome esiste già' });
      }

      const groupResult = await client.query(
        `INSERT INTO groups (name, db) VALUES ($1, $2)
         RETURNING id, name, db, created_at, updated_at`,
        [name, db]
      );
      const newGroup = groupResult.rows[0];

      if (items.length > 0) {
        for (const item of items) {
          if (!item.category_id) {
            await client.query('ROLLBACK');
            return reply.status(400).send({ error: 'Category ID is required for all items' });
          }
          await client.query(
            'INSERT INTO group_items (group_id, category_id) VALUES ($1, $2)',
            [newGroup.id, item.category_id]
          );
        }
      }

      await client.query('COMMIT');

      // Fetch full group with items
      const itemsResult = await client.query(
        `SELECT gi.id, gi.category_id, c.name AS category_name
         FROM group_items gi
         LEFT JOIN categories c ON gi.category_id = c.id
         WHERE gi.group_id = $1
         ORDER BY c.name ASC`,
        [newGroup.id]
      );
      newGroup.items = itemsResult.rows;

      reply.status(201).send({ success: true, data: newGroup });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error creating group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // PUT /:id — update group
  fastify.put('/:id', async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { id } = request.params;
      const { name, db, items } = request.body;
      if (!db) return reply.status(400).send({ error: 'Database parameter is required' });

      await client.query('BEGIN');

      const existing = await client.query(
        'SELECT id FROM groups WHERE id = $1 AND db = $2', [id, db]
      );
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'Group not found' });
      }

      if (name) {
        await client.query(
          'UPDATE groups SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [name, id]
        );
      }

      if (items && Array.isArray(items)) {
        await client.query('DELETE FROM group_items WHERE group_id = $1', [id]);
        for (const item of items) {
          if (!item.category_id) {
            await client.query('ROLLBACK');
            return reply.status(400).send({ error: 'Category ID is required for all items' });
          }
          await client.query(
            'INSERT INTO group_items (group_id, category_id) VALUES ($1, $2)',
            [id, item.category_id]
          );
        }
      }

      await client.query('COMMIT');

      const groupResult = await client.query(
        'SELECT id, name, db, created_at, updated_at FROM groups WHERE id = $1', [id]
      );
      const updatedGroup = groupResult.rows[0];
      const itemsResult = await client.query(
        `SELECT gi.id, gi.category_id, c.name AS category_name
         FROM group_items gi
         LEFT JOIN categories c ON gi.category_id = c.id
         WHERE gi.group_id = $1
         ORDER BY c.name ASC`,
        [id]
      );
      updatedGroup.items = itemsResult.rows;
      reply.send({ success: true, data: updatedGroup });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // DELETE /:id — delete group
  fastify.delete('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db } = request.query;
      if (!db) return reply.status(400).send({ error: 'Database parameter is required' });

      const result = await fastify.pg.query(
        'DELETE FROM groups WHERE id = $1 AND db = $2 RETURNING id, name',
        [id, db]
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Group not found' });
      }
      reply.send({
        success: true,
        message: `Gruppo "${result.rows[0].name}" eliminato con successo`
      });
    } catch (error) {
      console.error('Error deleting group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

export default groupsRoutes;
