// routes/cashFlow.js
import { createMinioClient, ensureBucketExists } from '../lib/minio-config.js';

const MINIO_BUCKET_CASH_FLOW = 'cash-flow-receipts';

export default async function cashFlowRoutes(fastify, options) {
  const preHandler = fastify.authenticate;

  // 1. POST /list — List withdrawals with optional filters
  fastify.post('/list', { preHandler }, async (request, reply) => {
    try {
      const { filters = {} } = request.body;

      let queryText = `
        SELECT
          cf.id,
          cf.owner_id,
          o.name AS owner_name,
          to_char(cf.withdrawal_date, 'YYYY-MM-DD') AS withdrawal_date,
          cf.amount,
          cf.employee_name,
          cf.description,
          cf.status,
          cf.transaction_id,
          to_char(t.date, 'YYYY-MM-DD') AS transaction_date,
          t.description AS transaction_description,
          t.amount AS transaction_amount,
          to_char(cf.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
          to_char(cf.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
          COALESCE(SUM(cfe.amount), 0) AS total_spent,
          (cf.amount - COALESCE(SUM(cfe.amount), 0)) AS remaining_balance,
          (SELECT COUNT(*) FROM cash_flow_expenses cfe2 WHERE cfe2.cash_flow_id = cf.id) AS expenses_count
        FROM cash_flow cf
        LEFT JOIN owners o ON cf.owner_id = o.id
        LEFT JOIN cash_flow_expenses cfe ON cfe.cash_flow_id = cf.id
        LEFT JOIN transactions t ON cf.transaction_id = t.id
        WHERE 1=1
      `;

      const queryParams = [];

      if (filters.ownerId) {
        queryParams.push(filters.ownerId);
        queryText += ` AND cf.owner_id = $${queryParams.length}`;
      }

      if (filters.status) {
        queryParams.push(filters.status);
        queryText += ` AND cf.status = $${queryParams.length}`;
      }

      if (filters.dateFrom) {
        queryParams.push(filters.dateFrom);
        queryText += ` AND cf.withdrawal_date >= $${queryParams.length}`;
      }

      if (filters.dateTo) {
        queryParams.push(filters.dateTo);
        queryText += ` AND cf.withdrawal_date <= $${queryParams.length}`;
      }

      if (filters.employeeName) {
        queryParams.push(`%${filters.employeeName}%`);
        queryText += ` AND cf.employee_name ILIKE $${queryParams.length}`;
      }

      queryText += `
        GROUP BY cf.id, cf.owner_id, o.name, cf.withdrawal_date, cf.amount,
                 cf.employee_name, cf.description, cf.status, cf.created_at, cf.updated_at,
                 cf.transaction_id, t.date, t.description, t.amount
        ORDER BY cf.withdrawal_date DESC, cf.created_at DESC
      `;

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, queryParams);
        reply.send({ success: true, data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il recupero dei prelievi:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante il recupero dei prelievi',
        message: error.message,
      });
    }
  });

  // 2. POST /details — Single withdrawal by { id }
  fastify.post('/details', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;

      if (!id) {
        return reply.status(400).send({ success: false, error: 'ID non specificato' });
      }

      const client = await fastify.pg.pool.connect();
      try {
        // Fetch header info with totals
        const headerResult = await client.query(
          `SELECT
             cf.id,
             cf.owner_id,
             o.name AS owner_name,
             to_char(cf.withdrawal_date, 'YYYY-MM-DD') AS withdrawal_date,
             cf.amount,
             cf.employee_name,
             cf.description,
             cf.status,
             cf.transaction_id,
             to_char(t.date, 'YYYY-MM-DD') AS transaction_date,
             t.description AS transaction_description,
             t.amount AS transaction_amount,
             to_char(cf.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
             to_char(cf.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
             COALESCE(SUM(cfe.amount), 0) AS total_spent,
             (cf.amount - COALESCE(SUM(cfe.amount), 0)) AS remaining_balance
           FROM cash_flow cf
           LEFT JOIN owners o ON cf.owner_id = o.id
           LEFT JOIN cash_flow_expenses cfe ON cfe.cash_flow_id = cf.id
           LEFT JOIN transactions t ON cf.transaction_id = t.id
           WHERE cf.id = $1
           GROUP BY cf.id, cf.owner_id, o.name, cf.withdrawal_date, cf.amount,
                    cf.employee_name, cf.description, cf.status, cf.created_at, cf.updated_at,
                    cf.transaction_id, t.date, t.description, t.amount`,
          [id]
        );

        if (headerResult.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Prelievo non trovato' });
        }

        // Global totals for pool model
        const globalResult = await client.query(
          `SELECT
             COALESCE(SUM(amount), 0) AS global_withdrawals,
             COALESCE((SELECT SUM(amount) FROM cash_flow_expenses), 0) AS global_spent
           FROM cash_flow`
        );

        // Fetch expenses for this withdrawal
        const expensesResult = await client.query(
          `SELECT
             id,
             cash_flow_id,
             to_char(expense_date, 'YYYY-MM-DD') AS expense_date,
             amount,
             category,
             description,
             recipient,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
           FROM cash_flow_expenses
           WHERE cash_flow_id = $1
           ORDER BY expense_date ASC`,
          [id]
        );

        // Fetch attachments for those expenses
        const expenseIds = expensesResult.rows.map((e) => e.id);
        let attachmentsMap = {};
        if (expenseIds.length > 0) {
          const attachmentsResult = await client.query(
            `SELECT
               id,
               expense_id,
               filename,
               original_name,
               type,
               to_char(uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uploaded_at
             FROM cash_flow_attachments
             WHERE expense_id = ANY($1::uuid[])`,
            [expenseIds]
          );

          // Group attachments by expense_id
          for (const att of attachmentsResult.rows) {
            if (!attachmentsMap[att.expense_id]) {
              attachmentsMap[att.expense_id] = [];
            }
            attachmentsMap[att.expense_id].push(att);
          }
        }

        // Attach attachments to each expense
        const expenses = expensesResult.rows.map((exp) => ({
          ...exp,
          attachments: attachmentsMap[exp.id] || [],
        }));

        reply.send({
          success: true,
          data: {
            ...headerResult.rows[0],
            expenses,
            global_withdrawals: parseFloat(globalResult.rows[0].global_withdrawals),
            global_spent: parseFloat(globalResult.rows[0].global_spent),
            global_remaining: parseFloat(globalResult.rows[0].global_withdrawals) - parseFloat(globalResult.rows[0].global_spent),
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il recupero dei dettagli del prelievo:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante il recupero dei dettagli del prelievo',
        message: error.message,
      });
    }
  });

  // 3. POST /create — Create withdrawal
  fastify.post('/create', { preHandler }, async (request, reply) => {
    try {
      const { owner_id, withdrawal_date, amount, employee_name, description, transaction_id } = request.body;

      // Validate required fields
      if (!owner_id) {
        return reply.status(400).send({ success: false, error: 'Il campo owner_id è obbligatorio' });
      }
      if (!withdrawal_date) {
        return reply.status(400).send({ success: false, error: 'Il campo withdrawal_date è obbligatorio' });
      }
      if (amount === undefined || amount === null || amount === '') {
        return reply.status(400).send({ success: false, error: 'Il campo amount è obbligatorio' });
      }
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO cash_flow (owner_id, withdrawal_date, amount, employee_name, description, transaction_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING
             id,
             owner_id,
             to_char(withdrawal_date, 'YYYY-MM-DD') AS withdrawal_date,
             amount,
             employee_name,
             description,
             status,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
             to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`,
          [owner_id, withdrawal_date, amount, employee_name || null, description || null, transaction_id || null]
        );

        reply.send({ success: true, data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante la creazione del prelievo:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante la creazione del prelievo',
        message: error.message,
      });
    }
  });

  // 4. POST /update — Update withdrawal
  fastify.post('/update', { preHandler }, async (request, reply) => {
    try {
      const { id, ...fields } = request.body;

      if (!id) {
        return reply.status(400).send({ success: false, error: 'ID non specificato' });
      }

      const client = await fastify.pg.pool.connect();
      try {
        // First, fetch current status
        const current = await client.query(
          `SELECT status FROM cash_flow WHERE id = $1`,
          [id]
        );

        if (current.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Prelievo non trovato' });
        }

        const currentStatus = current.rows[0].status;
        const allowedFields = currentStatus === 'open'
          ? ['owner_id', 'withdrawal_date', 'amount', 'employee_name', 'description']
          : ['description'];

        // Build SET clause dynamically
        const setClauses = [];
        const queryParams = [];
        let paramIndex = 1;

        for (const field of allowedFields) {
          if (fields[field] !== undefined) {
            paramIndex++;
            setClauses.push(`${field} = $${paramIndex}`);
            queryParams.push(fields[field]);
          }
        }

        if (setClauses.length === 0) {
          return reply.status(400).send({ success: false, error: 'Nessun campo da aggiornare' });
        }

        queryParams.push(id);

        const result = await client.query(
          `UPDATE cash_flow
           SET ${setClauses.join(', ')}, updated_at = NOW()
           WHERE id = $${paramIndex + 1}
           RETURNING
             id,
             owner_id,
             to_char(withdrawal_date, 'YYYY-MM-DD') AS withdrawal_date,
             amount,
             employee_name,
             description,
             status,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
             to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`,
          queryParams
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Prelievo non trovato' });
        }

        reply.send({ success: true, data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento del prelievo:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante l\'aggiornamento del prelievo',
        message: error.message,
      });
    }
  });

  // 5. POST /delete — Delete withdrawal (only if status = 'open')
  fastify.post('/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;

      if (!id) {
        return reply.status(400).send({ success: false, error: 'ID non specificato' });
      }

      const client = await fastify.pg.pool.connect();
      try {
        // Check status
        const current = await client.query(
          `SELECT status FROM cash_flow WHERE id = $1`,
          [id]
        );

        if (current.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Prelievo non trovato' });
        }

        if (current.rows[0].status !== 'open') {
          return reply.status(400).send({
            success: false,
            error: 'Impossibile eliminare un prelievo con stato diverso da "open"',
          });
        }

        await client.query(`DELETE FROM cash_flow WHERE id = $1`, [id]);

        reply.send({ success: true, data: { id } });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione del prelievo:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante l\'eliminazione del prelievo',
        message: error.message,
      });
    }
  });

  // 6. POST /update-status — Change status (open <-> closed)
  fastify.post('/update-status', { preHandler }, async (request, reply) => {
    try {
      const { id, status } = request.body;

      if (!id) {
        return reply.status(400).send({ success: false, error: 'ID non specificato' });
      }

      if (!status || !['open', 'closed'].includes(status)) {
        return reply.status(400).send({
          success: false,
          error: 'Stato non valido. I valori consentiti sono: open, closed',
        });
      }

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `UPDATE cash_flow
           SET status = $2, updated_at = NOW()
           WHERE id = $1
           RETURNING
             id,
             owner_id,
             to_char(withdrawal_date, 'YYYY-MM-DD') AS withdrawal_date,
             amount,
             employee_name,
             description,
             status,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
             to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`,
          [id, status]
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Prelievo non trovato' });
        }

        reply.send({ success: true, data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento dello stato del prelievo:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante l\'aggiornamento dello stato del prelievo',
        message: error.message,
      });
    }
  });

  // 7. POST /expense/create — Create expense linked to a cash_flow_id
  fastify.post('/expense/create', { preHandler }, async (request, reply) => {
    try {
      const { cash_flow_id, expense_date, amount, category, description, recipient } = request.body;

      if (!expense_date) {
        return reply.status(400).send({ success: false, error: 'Il campo expense_date è obbligatorio' });
      }
      if (amount === undefined || amount === null || amount === '') {
        return reply.status(400).send({ success: false, error: 'Il campo amount è obbligatorio' });
      }

      const client = await fastify.pg.pool.connect();
      try {
        // If linked to a withdrawal, validate it exists
        if (cash_flow_id) {
          const parentResult = await client.query(
            `SELECT id FROM cash_flow WHERE id = $1`,
            [cash_flow_id]
          );
          if (parentResult.rows.length === 0) {
            return reply.status(404).send({ success: false, error: 'Prelievo non trovato' });
          }
        }

        // Global constraint: total expenses cannot exceed total withdrawals
        const totalWithdrawals = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM cash_flow`
        );
        const totalSpent = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM cash_flow_expenses`
        );
        const newTotal = parseFloat(totalSpent.rows[0].total) + parseFloat(amount);
        if (newTotal > parseFloat(totalWithdrawals.rows[0].total)) {
          return reply.status(400).send({
            success: false,
            error: 'Il totale delle spese supererebbe il totale dei prelievi',
          });
        }

        const result = await client.query(
          `INSERT INTO cash_flow_expenses (cash_flow_id, expense_date, amount, category, description, recipient)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING
             id,
             cash_flow_id,
             to_char(expense_date, 'YYYY-MM-DD') AS expense_date,
             amount,
             category,
             description,
             recipient,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`,
          [cash_flow_id || null, expense_date, amount, category || null, description || null, recipient || null]
        );

        reply.send({ success: true, data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante la creazione della spesa:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante la creazione della spesa',
        message: error.message,
      });
    }
  });

  // 8. POST /expense/update — Update expense fields
  fastify.post('/expense/update', { preHandler }, async (request, reply) => {
    try {
      const { id, ...fields } = request.body;

      if (!id) {
        return reply.status(400).send({ success: false, error: 'ID spesa non specificato' });
      }

      const allowedFields = ['expense_date', 'amount', 'category', 'description', 'recipient'];
      const setClauses = [];
      const queryParams = [];
      let paramIndex = 1;

      for (const field of allowedFields) {
        if (fields[field] !== undefined) {
          paramIndex++;
          setClauses.push(`${field} = $${paramIndex}`);
          queryParams.push(fields[field]);
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ success: false, error: 'Nessun campo da aggiornare' });
      }

      queryParams.push(id);

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `UPDATE cash_flow_expenses
           SET ${setClauses.join(', ')}
           WHERE id = $${paramIndex + 1}
           RETURNING
             id,
             cash_flow_id,
             to_char(expense_date, 'YYYY-MM-DD') AS expense_date,
             amount,
             category,
             description,
             recipient,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`,
          queryParams
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Spesa non trovata' });
        }

        reply.send({ success: true, data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento della spesa:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante l\'aggiornamento della spesa',
        message: error.message,
      });
    }
  });

  // 9. POST /expense/delete — Delete expense by ID
  fastify.post('/expense/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;

      if (!id) {
        return reply.status(400).send({ success: false, error: 'ID spesa non specificato' });
      }

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `DELETE FROM cash_flow_expenses WHERE id = $1 RETURNING id`,
          [id]
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Spesa non trovata' });
        }

        reply.send({ success: true, data: { id } });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione della spesa:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante l\'eliminazione della spesa',
        message: error.message,
      });
    }
  });

  // 10. POST /expense/upload-attachment — Upload attachment to MinIO
  fastify.post('/expense/upload-attachment', { preHandler }, async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ success: false, error: 'Nessun file ricevuto' });
      }

      const { expense_id, type } = data.fields;

      if (!expense_id || !expense_id.value) {
        return reply.status(400).send({ success: false, error: 'Il campo expense_id è obbligatorio' });
      }
      if (!type || !type.value || !['receipt', 'declaration'].includes(type.value)) {
        return reply.status(400).send({
          success: false,
          error: 'Il campo type è obbligatorio. Valori consentiti: receipt, declaration',
        });
      }

      const buffer = await data.toBuffer();
      const ext = data.filename.split('.').pop();
      const objectName = `expenses/${expense_id.value}/${Date.now()}.${ext}`;

      const minioClient = createMinioClient();
      await ensureBucketExists(minioClient, MINIO_BUCKET_CASH_FLOW);
      await minioClient.putObject(MINIO_BUCKET_CASH_FLOW, objectName, buffer, buffer.length, {
        'Content-Type': data.mimetype,
      });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO cash_flow_attachments (expense_id, filename, original_name, type)
           VALUES ($1, $2, $3, $4)
           RETURNING id, filename, original_name, type,
             to_char(uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uploaded_at`,
          [expense_id.value, objectName, data.filename, type.value]
        );

        reply.send({ success: true, data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il caricamento dell\'allegato:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante il caricamento dell\'allegato',
        message: error.message,
      });
    }
  });

  // 11. POST /expense/delete-attachment — Delete attachment by ID
  fastify.post('/expense/delete-attachment', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;

      if (!id) {
        return reply.status(400).send({ success: false, error: 'ID allegato non specificato' });
      }

      const client = await fastify.pg.pool.connect();
      try {
        // Fetch the filename before deleting from DB
        const attResult = await client.query(
          `SELECT filename FROM cash_flow_attachments WHERE id = $1`,
          [id]
        );

        if (attResult.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Allegato non trovato' });
        }

        const filename = attResult.rows[0].filename;

        // Try to remove from MinIO
        try {
          const minioClient = createMinioClient();
          await minioClient.removeObject(MINIO_BUCKET_CASH_FLOW, filename);
        } catch (minioErr) {
          console.error('Errore durante la rimozione del file da MinIO (proseguo):', minioErr.message);
          // Continue with DB deletion even if MinIO removal fails
        }

        await client.query(`DELETE FROM cash_flow_attachments WHERE id = $1`, [id]);

        reply.send({ success: true, data: { id } });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione dell\'allegato:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante l\'eliminazione dell\'allegato',
        message: error.message,
      });
    }
  });

  // 12. GET /attachment/:filename — Serve file from MinIO
  fastify.get('/attachment/:filename', { preHandler }, async (request, reply) => {
    try {
      const objectName = decodeURIComponent(request.params.filename);
      const minioClient = createMinioClient();

      const stat = await minioClient.statObject(MINIO_BUCKET_CASH_FLOW, objectName);
      const stream = await minioClient.getObject(MINIO_BUCKET_CASH_FLOW, objectName);

      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const ext = objectName.split('.').pop()?.toLowerCase();
      const mimeTypes = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
      };

      reply
        .header('Content-Type', mimeTypes[ext] || 'application/octet-stream')
        .header('Content-Disposition', `inline; filename="${objectName.split('/').pop()}"`)
        .header('Content-Length', buffer.length)
        .send(buffer);
    } catch (error) {
      console.error('Errore durante il recupero dell\'allegato:', error);
      reply.status(500).send({
        success: false,
        error: 'Errore durante il recupero dell\'allegato',
        message: error.message,
      });
    }
  });
}
