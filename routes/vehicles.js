// routes/vehicles.js
import { createMinioClient, ensureBucketExists } from '../lib/minio-config.js';
import { calculateBollo } from '../lib/bollo-calculator.js';

const MINIO_BUCKET_VEHICLES = 'vehicle-documents';

const VALID_STATUSES = ['attivo', 'fermo', 'in_manutenzione', 'venduto', 'radiato'];

export default async function vehiclesRoutes(fastify, options) {
  const preHandler = fastify.authenticate;

  // ─── VEICOLI ──────────────────────────────────────────────────────────────

  // POST /list — lista veicoli con filtri
  fastify.post('/list', { preHandler }, async (request, reply) => {
    try {
      const { filters = {} } = request.body;

      let queryText = `
        SELECT
          v.id, v.plate, v.vin, v.make, v.model,
          to_char(v.registration_date, 'YYYY-MM-DD') AS registration_date,
          v.vehicle_usage, v.fuel_type, v.kw, v.engine_cc, v.seats,
          v.status, v.owner_type, v.owner_name,
          v.availability_type, v.assignee_type, v.assignee_name,
          v.assignment_notes,
          to_char(v.purchase_date, 'YYYY-MM-DD') AS purchase_date,
          v.purchase_vendor, v.purchase_amount, v.purchase_notes,
          to_char(v.disposal_date, 'YYYY-MM-DD') AS disposal_date,
          v.disposal_buyer, v.disposal_amount, v.disposal_reason, v.disposal_notes,
          v.notes,
          v.telepass_serial, v.telepass_notes,
          to_char(v.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
          to_char(v.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
        FROM vehicles v
        WHERE 1=1
      `;

      const queryParams = [];

      if (filters.search) {
        queryParams.push(`%${filters.search}%`);
        const idx = queryParams.length;
        queryText += ` AND (
          v.plate ILIKE $${idx} OR
          v.make ILIKE $${idx} OR
          v.model ILIKE $${idx} OR
          v.owner_name ILIKE $${idx} OR
          v.assignee_name ILIKE $${idx}
        )`;
      }

      if (filters.status) {
        queryParams.push(filters.status);
        queryText += ` AND v.status = $${queryParams.length}`;
      }

      if (filters.ownerType) {
        queryParams.push(filters.ownerType);
        queryText += ` AND v.owner_type = $${queryParams.length}`;
      }

      if (filters.availabilityType) {
        queryParams.push(filters.availabilityType);
        queryText += ` AND v.availability_type = $${queryParams.length}`;
      }

      if (filters.assigneeName) {
        queryParams.push(`%${filters.assigneeName}%`);
        queryText += ` AND v.assignee_name ILIKE $${queryParams.length}`;
      }

      queryText += ` ORDER BY v.created_at DESC`;

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, queryParams);
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero veicoli', message: error.message });
    }
  });

  // POST /details — dettaglio veicolo
  fastify.post('/details', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `SELECT
            v.*,
            to_char(v.registration_date, 'YYYY-MM-DD') AS registration_date,
            to_char(v.purchase_date, 'YYYY-MM-DD') AS purchase_date,
            to_char(v.disposal_date, 'YYYY-MM-DD') AS disposal_date,
            to_char(v.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(v.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
          FROM vehicles v WHERE v.id = $1`,
          [id]
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Veicolo non trovato' });
        reply.send({ data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero dettaglio veicolo', message: error.message });
    }
  });

  // POST /create — crea veicolo
  fastify.post('/create', { preHandler }, async (request, reply) => {
    try {
      const { vehicle } = request.body;
      if (!vehicle) return reply.status(400).send({ error: 'Dati veicolo non specificati' });
      if (!vehicle.plate) return reply.status(400).send({ error: 'Targa obbligatoria' });
      if (vehicle.status && !VALID_STATUSES.includes(vehicle.status)) {
        return reply.status(400).send({ error: `Stato non valido. Valori ammessi: ${VALID_STATUSES.join(', ')}` });
      }

      const {
        plate, vin, make, model, registration_date, vehicle_usage,
        fuel_type, kw, engine_cc, seats,
        status = 'attivo',
        owner_type, owner_name, availability_type,
        assignee_type, assignee_name, assignment_notes,
        purchase_date, purchase_vendor, purchase_amount, purchase_notes,
        disposal_date, disposal_buyer, disposal_amount, disposal_reason, disposal_notes,
        notes,
      } = vehicle;

      const client = await fastify.pg.pool.connect();
      try {
        // Check duplicate plate
        const existing = await client.query('SELECT id FROM vehicles WHERE plate = $1', [plate.toUpperCase()]);
        if (existing.rows.length > 0) {
          return reply.status(409).send({ error: 'Targa già presente nel sistema' });
        }

        const result = await client.query(
          `INSERT INTO vehicles (
            plate, vin, make, model, registration_date, vehicle_usage,
            fuel_type, kw, engine_cc, seats, status,
            owner_type, owner_name, availability_type,
            assignee_type, assignee_name, assignment_notes,
            purchase_date, purchase_vendor, purchase_amount, purchase_notes,
            disposal_date, disposal_buyer, disposal_amount, disposal_reason, disposal_notes,
            notes
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
            $12,$13,$14,$15,$16,$17,
            $18,$19,$20,$21,
            $22,$23,$24,$25,$26,$27
          ) RETURNING *`,
          [
            plate.toUpperCase(), vin || null, make || null, model || null,
            registration_date || null, vehicle_usage || null,
            fuel_type || null, kw || null, engine_cc || null, seats || null,
            status,
            owner_type || null, owner_name || null, availability_type || null,
            assignee_type || null, assignee_name || null, assignment_notes || null,
            purchase_date || null, purchase_vendor || null,
            purchase_amount || null, purchase_notes || null,
            disposal_date || null, disposal_buyer || null,
            disposal_amount || null, disposal_reason || null, disposal_notes || null,
            notes || null,
          ]
        );
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore creazione veicolo', message: error.message });
    }
  });

  // POST /update — aggiorna veicolo
  fastify.post('/update', { preHandler }, async (request, reply) => {
    try {
      const { id, vehicle } = request.body;
      if (!id || !vehicle) return reply.status(400).send({ error: 'ID o dati veicolo non specificati' });
      if (vehicle.status && !VALID_STATUSES.includes(vehicle.status)) {
        return reply.status(400).send({ error: `Stato non valido. Valori ammessi: ${VALID_STATUSES.join(', ')}` });
      }

      const updatableFields = [
        'plate', 'vin', 'make', 'model', 'registration_date', 'vehicle_usage',
        'fuel_type', 'kw', 'engine_cc', 'seats', 'status',
        'owner_type', 'owner_name', 'availability_type',
        'assignee_type', 'assignee_name', 'assignment_notes',
        'purchase_date', 'purchase_vendor', 'purchase_amount', 'purchase_notes',
        'disposal_date', 'disposal_buyer', 'disposal_amount', 'disposal_reason', 'disposal_notes',
        'notes', 'telepass_serial', 'telepass_notes',
      ];

      const setClauses = [];
      const queryParams = [id];
      let paramIndex = 2;

      for (const field of updatableFields) {
        if (vehicle[field] !== undefined) {
          if (field === 'plate') {
            setClauses.push(`${field} = $${paramIndex++}`);
            queryParams.push(vehicle[field].toUpperCase());
          } else {
            setClauses.push(`${field} = $${paramIndex++}`);
            queryParams.push(vehicle[field]);
          }
        }
      }

      if (setClauses.length === 0) return reply.status(400).send({ error: 'Nessun campo da aggiornare' });

      setClauses.push(`updated_at = NOW()`);

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `UPDATE vehicles SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
          queryParams
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Veicolo non trovato' });
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore aggiornamento veicolo', message: error.message });
    }
  });

  // POST /delete — elimina veicolo
  fastify.post('/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query('DELETE FROM vehicles WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Veicolo non trovato' });
        reply.send({ success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore eliminazione veicolo', message: error.message });
    }
  });

  // ─── DOCUMENTI ────────────────────────────────────────────────────────────

  // POST /documents/list
  fastify.post('/documents/list', { preHandler }, async (request, reply) => {
    try {
      const { vehicle_id } = request.body;
      if (!vehicle_id) return reply.status(400).send({ error: 'vehicle_id non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `SELECT *, to_char(document_date, 'YYYY-MM-DD') AS document_date,
            to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
           FROM vehicle_documents WHERE vehicle_id = $1 ORDER BY vehicle_documents.created_at DESC`,
          [vehicle_id]
        );
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero documenti', message: error.message });
    }
  });

  // POST /documents/create
  fastify.post('/documents/create', { preHandler }, async (request, reply) => {
    try {
      const { document } = request.body;
      if (!document?.vehicle_id || !document?.document_type || !document?.title || !document?.file_path) {
        return reply.status(400).send({ error: 'Campi obbligatori mancanti: vehicle_id, document_type, title, file_path' });
      }

      const { vehicle_id, document_type, title, file_path, document_date, expiry_date, related_entity_type, related_entity_id, notes } = document;

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO vehicle_documents
            (vehicle_id, document_type, title, file_path, document_date, expiry_date, related_entity_type, related_entity_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [vehicle_id, document_type, title, file_path, document_date || null, expiry_date || null, related_entity_type || null, related_entity_id || null, notes || null]
        );
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore creazione documento', message: error.message });
    }
  });

  // POST /documents/delete
  fastify.post('/documents/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query('DELETE FROM vehicle_documents WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Documento non trovato' });
        reply.send({ success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore eliminazione documento', message: error.message });
    }
  });

  // POST /documents/upload — upload file su MinIO
  fastify.post('/documents/upload', { preHandler }, async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'Nessun file ricevuto' });

      const vehicleId = request.query.vehicle_id || 'unknown';
      const category = request.query.category || 'altri';
      const buffer = await data.toBuffer();
      const ext = data.filename.split('.').pop();
      const objectName = `auto/${vehicleId}/${category}/${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

      const minioClient = createMinioClient();
      await ensureBucketExists(minioClient, MINIO_BUCKET_VEHICLES);
      await minioClient.putObject(MINIO_BUCKET_VEHICLES, objectName, buffer, buffer.length, {
        'Content-Type': data.mimetype,
      });

      const url = `/api/vehicles/documents/file/${encodeURIComponent(objectName)}`;
      reply.send({ data: { url, object_name: objectName, file_path: objectName } });
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore upload documento veicolo', message: error.message });
    }
  });

  // GET /documents/file/* — serve file da MinIO
  fastify.get('/documents/file/*', { preHandler }, async (request, reply) => {
    try {
      const objectName = decodeURIComponent(request.params['*']);
      const minioClient = createMinioClient();
      const stream = await minioClient.getObject(MINIO_BUCKET_VEHICLES, objectName);

      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      const ext = objectName.split('.').pop()?.toLowerCase();
      const mimeTypes = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
      reply
        .header('Content-Type', mimeTypes[ext] || 'application/octet-stream')
        .header('Content-Disposition', `inline; filename="${objectName.split('/').pop()}"`)
        .header('Content-Length', buffer.length)
        .send(buffer);
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero file veicolo', message: error.message });
    }
  });

  // ─── MANUTENZIONI ─────────────────────────────────────────────────────────

  // POST /maintenance/list
  fastify.post('/maintenance/list', { preHandler }, async (request, reply) => {
    try {
      const { vehicle_id } = request.body;
      if (!vehicle_id) return reply.status(400).send({ error: 'vehicle_id non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `SELECT *,
            to_char(maintenance_date, 'YYYY-MM-DD') AS maintenance_date,
            to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
           FROM vehicle_maintenance WHERE vehicle_id = $1 ORDER BY maintenance_date DESC`,
          [vehicle_id]
        );
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero manutenzioni', message: error.message });
    }
  });

  // POST /maintenance/create
  fastify.post('/maintenance/create', { preHandler }, async (request, reply) => {
    try {
      const { maintenance } = request.body;
      if (!maintenance?.vehicle_id || !maintenance?.maintenance_type || !maintenance?.title || !maintenance?.maintenance_date) {
        return reply.status(400).send({ error: 'Campi obbligatori: vehicle_id, maintenance_type, title, maintenance_date' });
      }

      const { vehicle_id, maintenance_type, title, maintenance_date, mileage, vendor, amount, next_due_date, next_due_mileage, notes } = maintenance;

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO vehicle_maintenance
            (vehicle_id, maintenance_type, title, maintenance_date, mileage, vendor, amount, next_due_date, next_due_mileage, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [vehicle_id, maintenance_type, title, maintenance_date, mileage || null, vendor || null, amount || null, next_due_date || null, next_due_mileage || null, notes || null]
        );
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore creazione manutenzione', message: error.message });
    }
  });

  // POST /maintenance/update
  fastify.post('/maintenance/update', { preHandler }, async (request, reply) => {
    try {
      const { id, maintenance } = request.body;
      if (!id || !maintenance) return reply.status(400).send({ error: 'ID o dati non specificati' });

      const fields = ['maintenance_type', 'title', 'maintenance_date', 'mileage', 'vendor', 'amount', 'next_due_date', 'next_due_mileage', 'notes'];
      const setClauses = [];
      const queryParams = [id];
      let paramIndex = 2;

      for (const field of fields) {
        if (maintenance[field] !== undefined) {
          setClauses.push(`${field} = $${paramIndex++}`);
          queryParams.push(maintenance[field]);
        }
      }

      if (setClauses.length === 0) return reply.status(400).send({ error: 'Nessun campo da aggiornare' });
      setClauses.push('updated_at = NOW()');

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `UPDATE vehicle_maintenance SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
          queryParams
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Manutenzione non trovata' });
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore aggiornamento manutenzione', message: error.message });
    }
  });

  // POST /maintenance/delete
  fastify.post('/maintenance/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query('DELETE FROM vehicle_maintenance WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Manutenzione non trovata' });
        reply.send({ success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore eliminazione manutenzione', message: error.message });
    }
  });

  // ─── PNEUMATICI ───────────────────────────────────────────────────────────

  // POST /tires/list
  fastify.post('/tires/list', { preHandler }, async (request, reply) => {
    try {
      const { vehicle_id } = request.body;
      if (!vehicle_id) return reply.status(400).send({ error: 'vehicle_id non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `SELECT *,
            to_char(install_date, 'YYYY-MM-DD') AS install_date,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
           FROM vehicle_tires WHERE vehicle_id = $1 ORDER BY vehicle_tires.created_at DESC`,
          [vehicle_id]
        );
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero pneumatici', message: error.message });
    }
  });

  // POST /tires/create
  fastify.post('/tires/create', { preHandler }, async (request, reply) => {
    try {
      const { tire } = request.body;
      if (!tire?.vehicle_id || !tire?.tire_type) {
        return reply.status(400).send({ error: 'Campi obbligatori: vehicle_id, tire_type' });
      }

      const { vehicle_id, tire_type, brand, model, size, install_date, mileage_at_install, storage_location, condition, notes } = tire;

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO vehicle_tires
            (vehicle_id, tire_type, brand, model, size, install_date, mileage_at_install, storage_location, condition, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [vehicle_id, tire_type, brand || null, model || null, size || null, install_date || null, mileage_at_install || null, storage_location || null, condition || null, notes || null]
        );
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore creazione pneumatici', message: error.message });
    }
  });

  // POST /tires/update
  fastify.post('/tires/update', { preHandler }, async (request, reply) => {
    try {
      const { id, tire } = request.body;
      if (!id || !tire) return reply.status(400).send({ error: 'ID o dati non specificati' });

      const fields = ['tire_type', 'brand', 'model', 'size', 'install_date', 'mileage_at_install', 'storage_location', 'condition', 'notes'];
      const setClauses = [];
      const queryParams = [id];
      let paramIndex = 2;

      for (const field of fields) {
        if (tire[field] !== undefined) {
          setClauses.push(`${field} = $${paramIndex++}`);
          queryParams.push(tire[field]);
        }
      }

      if (setClauses.length === 0) return reply.status(400).send({ error: 'Nessun campo da aggiornare' });
      setClauses.push('updated_at = NOW()');

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `UPDATE vehicle_tires SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
          queryParams
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Record pneumatici non trovato' });
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore aggiornamento pneumatici', message: error.message });
    }
  });

  // POST /tires/delete
  fastify.post('/tires/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query('DELETE FROM vehicle_tires WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Record non trovato' });
        reply.send({ success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore eliminazione pneumatici', message: error.message });
    }
  });

  // ─── SINISTRI / EVENTI ────────────────────────────────────────────────────

  // POST /incidents/list
  fastify.post('/incidents/list', { preHandler }, async (request, reply) => {
    try {
      const { vehicle_id } = request.body;
      if (!vehicle_id) return reply.status(400).send({ error: 'vehicle_id non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `SELECT *,
            to_char(incident_date, 'YYYY-MM-DD') AS incident_date,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
           FROM vehicle_incidents WHERE vehicle_id = $1 ORDER BY incident_date DESC`,
          [vehicle_id]
        );
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero sinistri', message: error.message });
    }
  });

  // POST /incidents/create
  fastify.post('/incidents/create', { preHandler }, async (request, reply) => {
    try {
      const { incident } = request.body;
      if (!incident?.vehicle_id || !incident?.incident_type || !incident?.title || !incident?.incident_date) {
        return reply.status(400).send({ error: 'Campi obbligatori: vehicle_id, incident_type, title, incident_date' });
      }

      const { vehicle_id, incident_type, title, incident_date, description, damage_amount, insurance_claim_number, status = 'aperto', notes } = incident;

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO vehicle_incidents
            (vehicle_id, incident_type, title, incident_date, description, damage_amount, insurance_claim_number, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [vehicle_id, incident_type, title, incident_date, description || null, damage_amount || null, insurance_claim_number || null, status, notes || null]
        );
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore creazione sinistro', message: error.message });
    }
  });

  // POST /incidents/update
  fastify.post('/incidents/update', { preHandler }, async (request, reply) => {
    try {
      const { id, incident } = request.body;
      if (!id || !incident) return reply.status(400).send({ error: 'ID o dati non specificati' });

      const fields = ['incident_type', 'title', 'incident_date', 'description', 'damage_amount', 'insurance_claim_number', 'status', 'notes'];
      const setClauses = [];
      const queryParams = [id];
      let paramIndex = 2;

      for (const field of fields) {
        if (incident[field] !== undefined) {
          setClauses.push(`${field} = $${paramIndex++}`);
          queryParams.push(incident[field]);
        }
      }

      if (setClauses.length === 0) return reply.status(400).send({ error: 'Nessun campo da aggiornare' });
      setClauses.push('updated_at = NOW()');

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `UPDATE vehicle_incidents SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
          queryParams
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Sinistro non trovato' });
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore aggiornamento sinistro', message: error.message });
    }
  });

  // POST /incidents/delete
  fastify.post('/incidents/delete', { preHandler }, async (request, reply) => {
    try {
      const { id } = request.body;
      if (!id) return reply.status(400).send({ error: 'ID non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query('DELETE FROM vehicle_incidents WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Sinistro non trovato' });
        reply.send({ success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore eliminazione sinistro', message: error.message });
    }
  });

  // ─── TIMELINE ─────────────────────────────────────────────────────────────

  // POST /timeline — timeline derivata (no tabella dedicata)
  fastify.post('/timeline', { preHandler }, async (request, reply) => {
    try {
      const { vehicle_id } = request.body;
      if (!vehicle_id) return reply.status(400).send({ error: 'vehicle_id non specificato' });

      const client = await fastify.pg.pool.connect();
      try {
        // Vehicle creation
        const vehicleRes = await client.query(
          `SELECT id, created_at as date, plate, make, model FROM vehicles WHERE id = $1`,
          [vehicle_id]
        );

        // Documents
        const docsRes = await client.query(
          `SELECT id, created_at as date, document_type, title FROM vehicle_documents WHERE vehicle_id = $1`,
          [vehicle_id]
        );

        // Maintenance
        const maintRes = await client.query(
          `SELECT id, maintenance_date as date, maintenance_type, title FROM vehicle_maintenance WHERE vehicle_id = $1`,
          [vehicle_id]
        );

        // Tires
        const tiresRes = await client.query(
          `SELECT id, install_date as date, tire_type, brand, model FROM vehicle_tires WHERE vehicle_id = $1`,
          [vehicle_id]
        );

        // Incidents
        const incidentsRes = await client.query(
          `SELECT id, incident_date as date, incident_type, title FROM vehicle_incidents WHERE vehicle_id = $1`,
          [vehicle_id]
        );

        // Assignments history
        const assignRes = await client.query(
          `SELECT id, assigned_at as date, assignee_type, assignee_name, notes FROM vehicle_assignments_history WHERE vehicle_id = $1`,
          [vehicle_id]
        );

        const timeline = [
          ...vehicleRes.rows.map(r => ({ type: 'vehicle_created', date: r.date, title: `Veicolo creato: ${r.plate}`, meta: { make: r.make, model: r.model } })),
          ...docsRes.rows.map(r => ({ type: 'document', date: r.date, title: r.title, meta: { document_type: r.document_type } })),
          ...maintRes.rows.map(r => ({ type: 'maintenance', date: r.date, title: r.title, meta: { maintenance_type: r.maintenance_type } })),
          ...tiresRes.rows.map(r => ({ type: 'tires', date: r.date, title: `Pneumatici ${r.tire_type}${r.brand ? ' - ' + r.brand : ''}`, meta: { tire_type: r.tire_type } })),
          ...incidentsRes.rows.map(r => ({ type: 'incident', date: r.date, title: r.title, meta: { incident_type: r.incident_type } })),
          ...assignRes.rows.map(r => ({ type: 'assignment', date: r.date, title: `Assegnato a ${r.assignee_name || 'N/D'}`, meta: { assignee_type: r.assignee_type, notes: r.notes } })),
        ]
          .filter(e => e.date)
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        reply.send({ data: timeline });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Errore recupero timeline', message: error.message });
    }
  });

  // ─── POLIZZE ──────────────────────────────────────────────────────────────

  // POST /policies/list
  fastify.post('/policies/list', { preHandler }, async (request, reply) => {
    const { vehicleId } = request.body;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, vehicle_id, policy_number, insurer, policy_types, broker,
                to_char(start_date, 'YYYY-MM-DD') AS start_date,
                to_char(end_date, 'YYYY-MM-DD') AS end_date,
                premium_amount, status, notes,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM vehicle_policies WHERE vehicle_id = $1 ORDER BY start_date DESC`,
        [vehicleId]
      );
      reply.send({ data: result.rows });
    } finally { client.release(); }
  });

  // POST /policies/create
  fastify.post('/policies/create', { preHandler }, async (request, reply) => {
    const { policy } = request.body;
    if (!policy?.vehicle_id || !policy?.policy_number || !policy?.insurer || !policy?.start_date || !policy?.end_date) {
      return reply.status(400).send({ error: 'Campi obbligatori: vehicle_id, policy_number, insurer, start_date, end_date' });
    }
    const { vehicle_id, policy_number, insurer, policy_types = [], broker, start_date, end_date, premium_amount, status = 'attiva', notes } = policy;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO vehicle_policies (vehicle_id, policy_number, insurer, policy_types, broker, start_date, end_date, premium_amount, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [vehicle_id, policy_number, insurer, policy_types, broker, start_date, end_date, premium_amount, status, notes]
      );
      reply.send({ id: result.rows[0].id });
    } finally { client.release(); }
  });

  // POST /policies/update
  fastify.post('/policies/update', { preHandler }, async (request, reply) => {
    const { id, policy } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const { policy_number, insurer, policy_types, broker, start_date, end_date, premium_amount, status, notes } = policy;
    const client = await fastify.pg.pool.connect();
    try {
      await client.query(
        `UPDATE vehicle_policies SET policy_number=$1, insurer=$2, policy_types=$3, broker=$4,
         start_date=$5, end_date=$6, premium_amount=$7, status=$8, notes=$9, updated_at=NOW()
         WHERE id=$10`,
        [policy_number, insurer, policy_types, broker, start_date, end_date, premium_amount, status, notes, id]
      );
      reply.send({ success: true });
    } finally { client.release(); }
  });

  // POST /policies/delete
  fastify.post('/policies/delete', { preHandler }, async (request, reply) => {
    const { id } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const client = await fastify.pg.pool.connect();
    try {
      await client.query('DELETE FROM vehicle_policies WHERE id = $1', [id]);
      reply.send({ success: true });
    } finally { client.release(); }
  });

  // ─── TASSE (BOLLO/SUPERBOLLO) ─────────────────────────────────────────────

  // POST /taxes/list
  fastify.post('/taxes/list', { preHandler }, async (request, reply) => {
    const { vehicleId } = request.body;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, vehicle_id, year, region, kw_at_payment, bollo_amount, superbollo_amount,
                (bollo_amount + superbollo_amount) AS total_amount,
                to_char(due_date, 'YYYY-MM-DD') AS due_date,
                to_char(paid_date, 'YYYY-MM-DD') AS paid_date,
                payment_method, status, notes,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM vehicle_taxes WHERE vehicle_id = $1 ORDER BY year DESC`,
        [vehicleId]
      );
      reply.send({ data: result.rows });
    } finally { client.release(); }
  });

  // POST /taxes/calculate — calcola importi senza salvare
  fastify.post('/taxes/calculate', { preHandler }, async (request, reply) => {
    const { kw, region } = request.body;
    reply.send(calculateBollo(kw, region));
  });

  // POST /taxes/create
  fastify.post('/taxes/create', { preHandler }, async (request, reply) => {
    const { tax } = request.body;
    if (!tax?.vehicle_id || !tax?.year) {
      return reply.status(400).send({ error: 'Campi obbligatori: vehicle_id, year' });
    }
    const { vehicle_id, year, region, kw_at_payment, bollo_amount, superbollo_amount, due_date, paid_date, payment_method, status = 'da_pagare', notes } = tax;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO vehicle_taxes (vehicle_id, year, region, kw_at_payment, bollo_amount, superbollo_amount, due_date, paid_date, payment_method, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [vehicle_id, year, region, kw_at_payment, bollo_amount || 0, superbollo_amount || 0, due_date, paid_date, payment_method, status, notes]
      );
      reply.send({ id: result.rows[0].id });
    } catch (err) {
      if (err.code === '23505') return reply.status(409).send({ error: 'Esiste già un record per questo veicolo e anno' });
      throw err;
    } finally { client.release(); }
  });

  // POST /taxes/update
  fastify.post('/taxes/update', { preHandler }, async (request, reply) => {
    const { id, tax } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const { year, region, kw_at_payment, bollo_amount, superbollo_amount, due_date, paid_date, payment_method, status, notes } = tax;
    const client = await fastify.pg.pool.connect();
    try {
      await client.query(
        `UPDATE vehicle_taxes SET year=$1, region=$2, kw_at_payment=$3, bollo_amount=$4,
         superbollo_amount=$5, due_date=$6, paid_date=$7, payment_method=$8, status=$9, notes=$10, updated_at=NOW()
         WHERE id=$11`,
        [year, region, kw_at_payment, bollo_amount, superbollo_amount, due_date, paid_date, payment_method, status, notes, id]
      );
      reply.send({ success: true });
    } finally { client.release(); }
  });

  // POST /taxes/delete
  fastify.post('/taxes/delete', { preHandler }, async (request, reply) => {
    const { id } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const client = await fastify.pg.pool.connect();
    try {
      await client.query('DELETE FROM vehicle_taxes WHERE id = $1', [id]);
      reply.send({ success: true });
    } finally { client.release(); }
  });

  // ─── ZTL ──────────────────────────────────────────────────────────────────

  // POST /ztl/list
  fastify.post('/ztl/list', { preHandler }, async (request, reply) => {
    const { vehicleId } = request.body;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, vehicle_id, city, authorization_number, permit_type,
                to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
                notes,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM vehicle_ztl WHERE vehicle_id = $1 ORDER BY valid_until DESC`,
        [vehicleId]
      );
      reply.send({ data: result.rows });
    } finally { client.release(); }
  });

  // POST /ztl/create
  fastify.post('/ztl/create', { preHandler }, async (request, reply) => {
    const { ztl } = request.body;
    if (!ztl?.vehicle_id) return reply.status(400).send({ error: 'vehicle_id obbligatorio' });
    const { vehicle_id, city, authorization_number, permit_type, valid_until, notes } = ztl;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO vehicle_ztl (vehicle_id, city, authorization_number, permit_type, valid_until, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [vehicle_id, city, authorization_number, permit_type, valid_until, notes]
      );
      reply.send({ id: result.rows[0].id });
    } finally { client.release(); }
  });

  // POST /ztl/update
  fastify.post('/ztl/update', { preHandler }, async (request, reply) => {
    const { id, ztl } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const { city, authorization_number, permit_type, valid_until, notes } = ztl;
    const client = await fastify.pg.pool.connect();
    try {
      await client.query(
        `UPDATE vehicle_ztl SET city=$1, authorization_number=$2, permit_type=$3, valid_until=$4, notes=$5, updated_at=NOW()
         WHERE id=$6`,
        [city, authorization_number, permit_type, valid_until, notes, id]
      );
      reply.send({ success: true });
    } finally { client.release(); }
  });

  // POST /ztl/delete
  fastify.post('/ztl/delete', { preHandler }, async (request, reply) => {
    const { id } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const client = await fastify.pg.pool.connect();
    try {
      await client.query('DELETE FROM vehicle_ztl WHERE id = $1', [id]);
      reply.send({ success: true });
    } finally { client.release(); }
  });

  // ─── CONTRAVVENZIONI ──────────────────────────────────────────────────────

  // POST /fines/list
  fastify.post('/fines/list', { preHandler }, async (request, reply) => {
    const { vehicleId } = request.body;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, vehicle_id, violation_number, issuing_authority, violation_type,
                to_char(fine_date, 'YYYY-MM-DD') AS fine_date,
                amount, discount_amount,
                to_char(due_date, 'YYYY-MM-DD') AS due_date,
                to_char(paid_date, 'YYYY-MM-DD') AS paid_date,
                payment_method, status, appeal_notes, notes,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM vehicle_fines WHERE vehicle_id = $1 ORDER BY fine_date DESC`,
        [vehicleId]
      );
      reply.send({ data: result.rows });
    } finally { client.release(); }
  });

  // POST /fines/create
  fastify.post('/fines/create', { preHandler }, async (request, reply) => {
    const { fine } = request.body;
    if (!fine?.vehicle_id || !fine?.fine_date) {
      return reply.status(400).send({ error: 'Campi obbligatori: vehicle_id, fine_date' });
    }
    const { vehicle_id, fine_date, violation_number, issuing_authority, violation_type, amount, discount_amount, due_date, paid_date, payment_method, status = 'da_pagare', appeal_notes, notes } = fine;
    const client = await fastify.pg.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO vehicle_fines (vehicle_id, fine_date, violation_number, issuing_authority, violation_type, amount, discount_amount, due_date, paid_date, payment_method, status, appeal_notes, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [vehicle_id, fine_date, violation_number, issuing_authority, violation_type, amount || 0, discount_amount, due_date, paid_date, payment_method, status, appeal_notes, notes]
      );
      reply.send({ id: result.rows[0].id });
    } finally { client.release(); }
  });

  // POST /fines/update
  fastify.post('/fines/update', { preHandler }, async (request, reply) => {
    const { id, fine } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const { fine_date, violation_number, issuing_authority, violation_type, amount, discount_amount, due_date, paid_date, payment_method, status, appeal_notes, notes } = fine;
    const client = await fastify.pg.pool.connect();
    try {
      await client.query(
        `UPDATE vehicle_fines SET fine_date=$1, violation_number=$2, issuing_authority=$3, violation_type=$4,
         amount=$5, discount_amount=$6, due_date=$7, paid_date=$8, payment_method=$9,
         status=$10, appeal_notes=$11, notes=$12, updated_at=NOW()
         WHERE id=$13`,
        [fine_date, violation_number, issuing_authority, violation_type, amount, discount_amount, due_date, paid_date, payment_method, status, appeal_notes, notes, id]
      );
      reply.send({ success: true });
    } finally { client.release(); }
  });

  // POST /fines/delete
  fastify.post('/fines/delete', { preHandler }, async (request, reply) => {
    const { id } = request.body;
    if (!id) return reply.status(400).send({ error: 'id obbligatorio' });
    const client = await fastify.pg.pool.connect();
    try {
      await client.query('DELETE FROM vehicle_fines WHERE id = $1', [id]);
      reply.send({ success: true });
    } finally { client.release(); }
  });
}
