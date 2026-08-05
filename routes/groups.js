/**
 * Groups Routes for Fastify
 * Handles CRUD operations for user-defined groups that aggregate categories and subjects
 */

async function groupsRoutes(fastify, options) {
  // Get all groups for a user in a specific database
  fastify.get('/', async (request, reply) => {
    try {
      const { db, user_id } = request.query;
      
      if (!db) {
        return reply.status(400).send({ error: 'Database parameter is required' });
      }

      // If user_id is provided, filter by user, otherwise get all groups for the db
      let query = `
        SELECT 
          g.id,
          g.name,
          g.description,
          g.db,
          g.user_id,
          g.created_at,
          g.updated_at,
          COUNT(gi.id) as items_count
        FROM groups g
        LEFT JOIN group_items gi ON g.id = gi.group_id
        WHERE g.db = $1
      `;
      
      const params = [db];
      
      if (user_id) {
        query += ` AND g.user_id = $2`;
        params.push(user_id);
      }
      
      query += ` GROUP BY g.id, g.name, g.description, g.db, g.user_id, g.created_at, g.updated_at
                 ORDER BY g.name ASC`;

      const result = await fastify.pg.query(query, params);
      
      reply.send({
        success: true,
        data: result.rows,
        total: result.rows.length
      });
      
    } catch (error) {
      console.error('Error fetching groups:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Get a specific group with its items
  fastify.get('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db } = request.query;
      
      if (!db) {
        return reply.status(400).send({ error: 'Database parameter is required' });
      }

      // Get group info
      const groupQuery = `
        SELECT 
          g.id,
          g.name,
          g.description,
          g.db,
          g.user_id,
          g.created_at,
          g.updated_at
        FROM groups g
        WHERE g.id = $1 AND g.db = $2
      `;
      
      const groupResult = await fastify.pg.query(groupQuery, [id, db]);
      
      if (groupResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Group not found' });
      }
      
      // Get group items with category names
      const itemsQuery = `
        SELECT 
          gi.id,
          gi.category_id,
          gi.subject_ids,
          gi.created_at,
          c.name as category_name
        FROM group_items gi
        LEFT JOIN categories c ON gi.category_id = c.id
        WHERE gi.group_id = $1
        ORDER BY c.name ASC
      `;
      
      const itemsResult = await fastify.pg.query(itemsQuery, [id]);
      
      const group = groupResult.rows[0];
      group.items = itemsResult.rows;
      
      reply.send({
        success: true,
        data: group
      });
      
    } catch (error) {
      console.error('Error fetching group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Create a new group
  fastify.post('/', async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      const { name, description, db, user_id, items = [] } = request.body;
      
      // Validate required fields
      if (!name || !db || !user_id) {
        return reply.status(400).send({ 
          error: 'Name, database, and user_id are required' 
        });
      }
      
      await client.query('BEGIN');
      
      // Check if group name already exists for this user/db
      const existingQuery = `
        SELECT id FROM groups 
        WHERE name = $1 AND db = $2 AND user_id = $3
      `;
      const existingResult = await client.query(existingQuery, [name, db, user_id]);
      
      if (existingResult.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ 
          error: 'A group with this name already exists' 
        });
      }
      
      // Create the group
      const insertGroupQuery = `
        INSERT INTO groups (name, description, db, user_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id, name, description, db, user_id, created_at, updated_at
      `;
      
      const groupResult = await client.query(insertGroupQuery, [
        name, description, db, user_id
      ]);
      
      const newGroup = groupResult.rows[0];
      
      // Insert group items if provided
      if (items.length > 0) {
        for (const item of items) {
          const { category_id, subject_ids = [] } = item;
          
          if (!category_id) {
            await client.query('ROLLBACK');
            return reply.status(400).send({ 
              error: 'Category ID is required for all items' 
            });
          }
          
          await client.query(
            `INSERT INTO group_items (group_id, category_id, subject_ids)
             VALUES ($1, $2, $3)`,
            [newGroup.id, category_id, subject_ids]
          );
        }
      }
      
      await client.query('COMMIT');
      
      // Return the created group with items
      const createdGroup = await getGroupWithItems(fastify, newGroup.id, db);
      
      reply.status(201).send({
        success: true,
        data: createdGroup
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error creating group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Update a group
  fastify.put('/:id', async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      const { id } = request.params;
      const { name, description, items, db } = request.body;
      
      if (!db) {
        return reply.status(400).send({ error: 'Database parameter is required' });
      }
      
      await client.query('BEGIN');
      
      // Check if group exists
      const existingQuery = `
        SELECT id FROM groups WHERE id = $1 AND db = $2
      `;
      const existingResult = await client.query(existingQuery, [id, db]);
      
      if (existingResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'Group not found' });
      }
      
      // Update group basic info
      if (name || description) {
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;
        
        if (name) {
          updateFields.push(`name = $${paramIndex++}`);
          updateValues.push(name);
        }
        
        if (description) {
          updateFields.push(`description = $${paramIndex++}`);
          updateValues.push(description);
        }
        
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
        updateValues.push(id);
        
        const updateQuery = `
          UPDATE groups 
          SET ${updateFields.join(', ')}
          WHERE id = $${paramIndex}
        `;
        
        await client.query(updateQuery, updateValues);
      }
      
      // Update group items if provided
      if (items && Array.isArray(items)) {
        // Delete existing items
        await client.query('DELETE FROM group_items WHERE group_id = $1', [id]);
        
        // Insert new items
        for (const item of items) {
          const { category_id, subject_ids = [] } = item;
          
          if (!category_id) {
            await client.query('ROLLBACK');
            return reply.status(400).send({ 
              error: 'Category ID is required for all items' 
            });
          }
          
          await client.query(
            `INSERT INTO group_items (group_id, category_id, subject_ids)
             VALUES ($1, $2, $3)`,
            [id, category_id, subject_ids]
          );
        }
      }
      
      await client.query('COMMIT');
      
      // Return the updated group
      const updatedGroup = await getGroupWithItems(fastify, id, db);
      
      reply.send({
        success: true,
        data: updatedGroup
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Delete a group
  fastify.delete('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db } = request.query;
      
      if (!db) {
        return reply.status(400).send({ error: 'Database parameter is required' });
      }
      
      const deleteQuery = `
        DELETE FROM groups 
        WHERE id = $1 AND db = $2
        RETURNING id, name
      `;
      
      const result = await fastify.pg.query(deleteQuery, [id, db]);
      
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Group not found' });
      }
      
      reply.send({
        success: true,
        message: `Group "${result.rows[0].name}" deleted successfully`
      });
      
    } catch (error) {
      console.error('Error deleting group:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Get available categories and subjects for group creation
  fastify.get('/available-items', async (request, reply) => {
    try {
      const { db } = request.query;
      
      if (!db) {
        return reply.status(400).send({ error: 'Database parameter is required' });
      }
      
      // Get categories with their subjects
      const query = `
        SELECT DISTINCT
          c.id as category_id,
          c.name as category_name,
          s.id as subject_id,
          s.name as subject_name
        FROM categories c
        LEFT JOIN subjects s ON c.id = s.category_id
        WHERE c.db = $1
        ORDER BY c.name ASC, s.name ASC
      `;
      
      const result = await fastify.pg.query(query, [db]);
      
      // Group subjects by category
      const categories = {};
      
      result.rows.forEach(row => {
        const { category_id, category_name, subject_id, subject_name } = row;
        
        if (!categories[category_id]) {
          categories[category_id] = {
            id: category_id,
            name: category_name,
            subjects: []
          };
        }
        
        if (subject_id) {
          categories[category_id].subjects.push({
            id: subject_id,
            name: subject_name
          });
        }
      });
      
      reply.send({
        success: true,
        data: Object.values(categories)
      });
      
    } catch (error) {
      console.error('Error fetching available items:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Get aggregated data for a group
  fastify.get('/:id/stats', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db, start_date, end_date } = request.query;
      
      if (!db) {
        return reply.status(400).send({ error: 'Database parameter is required' });
      }
      
      // Get group items
      const itemsQuery = `
        SELECT category_id, subject_ids 
        FROM group_items 
        WHERE group_id = $1
      `;
      
      const itemsResult = await fastify.pg.query(itemsQuery, [id]);
      
      if (itemsResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Group not found or empty' });
      }
      
      // Build dynamic query for transactions
      let transactionQuery = `
        SELECT 
          SUM(CASE WHEN type = 'uscita' THEN amount ELSE 0 END) as total_uscite,
          SUM(CASE WHEN type = 'entrata' THEN amount ELSE 0 END) as total_entrate,
          COUNT(*) as total_transactions,
          AVG(CASE WHEN type = 'uscita' THEN amount ELSE NULL END) as avg_uscita,
          AVG(CASE WHEN type = 'entrata' THEN amount ELSE NULL END) as avg_entrata
        FROM transactions t
        WHERE t.db = $1
      `;
      
      const queryParams = [db];
      let paramIndex = 2;
      
      // Add date filters
      if (start_date) {
        transactionQuery += ` AND t.date >= $${paramIndex}`;
        queryParams.push(start_date);
        paramIndex++;
      }
      
      if (end_date) {
        transactionQuery += ` AND t.date <= $${paramIndex}`;
        queryParams.push(end_date);
        paramIndex++;
      }
      
      // Build category/subject filter
      const categoryFilters = [];
      
      itemsResult.rows.forEach(item => {
        const { category_id, subject_ids } = item;
        
        if (subject_ids && subject_ids.length > 0) {
          // Filter by specific subjects
          const subjectPlaceholders = subject_ids.map(() => `$${paramIndex++}`).join(',');
          categoryFilters.push(`(t.category_id = '${category_id}' AND t.subject_id IN (${subjectPlaceholders}))`);
          queryParams.push(...subject_ids);
        } else {
          // Include all subjects for this category
          categoryFilters.push(`t.category_id = '${category_id}'`);
        }
      });
      
      if (categoryFilters.length > 0) {
        transactionQuery += ` AND (${categoryFilters.join(' OR ')})`;
      }
      
      const statsResult = await fastify.pg.query(transactionQuery, queryParams);
      
      reply.send({
        success: true,
        data: statsResult.rows[0]
      });
      
    } catch (error) {
      console.error('Error fetching group stats:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

/**
 * Helper function to get group with items
 */
async function getGroupWithItems(fastify, groupId, db) {
  const groupQuery = `
    SELECT 
      g.id,
      g.name,
      g.description,
      g.db,
      g.user_id,
      g.created_at,
      g.updated_at
    FROM groups g
    WHERE g.id = $1 AND g.db = $2
  `;
  
  const groupResult = await fastify.pg.query(groupQuery, [groupId, db]);
  
  if (groupResult.rows.length === 0) {
    return null;
  }
  
  const itemsQuery = `
    SELECT 
      gi.id,
      gi.category_id,
      gi.subject_ids,
      gi.created_at,
      c.name as category_name
    FROM group_items gi
    LEFT JOIN categories c ON gi.category_id = c.id
    WHERE gi.group_id = $1
    ORDER BY c.name ASC
  `;
  
  const itemsResult = await fastify.pg.query(itemsQuery, [groupId]);
  
  const group = groupResult.rows[0];
  group.items = itemsResult.rows;
  
  return group;
}

export default groupsRoutes;
