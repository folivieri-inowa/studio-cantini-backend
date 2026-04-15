// routes/scadenziario.js
import { createMinioClient, ensureBucketExists } from '../lib/minio-config.js';

const MINIO_BUCKET_SCADENZIARIO = 'scadenziario-attachments';
const DOCLING_URL = process.env.DOCLING_URL || 'http://localhost:5001';
const COPILOT_BRIDGE_URL = process.env.COPILOT_BRIDGE_URL || 'http://copilot-bridge.copilot-proxy.svc.cluster.local:8080';

async function extractInvoiceFieldsWithAI(text) {
  const systemPrompt = `Sei un assistente esperto in fatture italiane. Estrai i dati dalla fattura e rispondi SOLO con un oggetto JSON valido, senza markdown, senza testo aggiuntivo.`;

  const userPrompt = `Estrai i seguenti campi dalla fattura italiana qui sotto:
- "invoice_number": numero fattura (stringa). Cerca "Fattura N.", "Nr.", "N. fattura". Se non presente nel testo usa null.
- "invoice_date": data di emissione fattura in formato YYYY-MM-DD. Cerca vicino a "Fattura N." o "del". NON usare date di decreti/leggi come "28/12/2018". Se assente usa null.
- "due_date": data scadenza pagamento in formato YYYY-MM-DD. Cerca nella riga finale con importo e "Bonifico" (es. "1.998,88 € il 13/03/2026") oppure nella riga "Scadenze".
- "amount": importo totale come numero decimale senza simbolo €. Prendi il campo "Totale" in fondo (es. 1998.88).
- "company_name": nome del FORNITORE (chi emette la fattura, chi chiede il pagamento). È il PRIMO nome/ragione sociale prima della parola "Spettabile".
- "subject": nome del DESTINATARIO della fattura (chi deve pagare). È il nome/ragione sociale che appare DOPO "Spettabile" o "Intestato a".
- "description": descrizione del servizio dalla colonna "Descrizione" della tabella delle voci.
- "vat_number": partita IVA del fornitore, solo 11 cifre numeriche.
- "iban": codice IBAN completo (inizia con IT).
- "bank_name": nome della banca.
- "payment_terms": condizioni di pagamento come valore chiave tra: "immediato" (Vista fattura / immediato), "30gg" (30 giorni), "60gg" (60 giorni), "90gg" (90 giorni), "30ggfm" (30 gg fine mese), "60ggfm" (60 gg fine mese), "data_fissa" (data fissa). Scegli il più adatto in base alla riga "Scadenze".

Rispondi SOLO con JSON valido, nessun testo aggiuntivo.

Fattura:
${text}`;

  try {
    const res = await fetch(`${COPILOT_BRIDGE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) throw new Error(`copilot-bridge error: ${res.status}`);
    const data = await res.json();
    const rawText = data.content?.[0]?.text ?? '';
    // Strip markdown code fences if present
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonText);
    console.log('[OCR] Campi estratti da copilot-bridge:', JSON.stringify(parsed));
    return parsed;
  } catch (err) {
    console.error('[OCR] copilot-bridge fallback a regex:', err.message);
    return null;
  }
}

function extractInvoiceFieldsWithRegex(text) {
  const invoiceNumber = text.match(/(?:fattura\s*n\.?|nr\.?|n\.)\s*[:\s]*([\w\/\-]+)/i)?.[1] || null;
  const dateMatches  = [...text.matchAll(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/g)];
  const invoiceDate  = dateMatches[0] ? `${dateMatches[0][3]}-${dateMatches[0][2]}-${dateMatches[0][1]}` : null;
  const dueDate      = dateMatches[1] ? `${dateMatches[1][3]}-${dateMatches[1][2]}-${dateMatches[1][1]}` : null;
  const amountMatch  = text.match(/(?:totale|importo totale)[^\d]*([\d.,]+)/i)?.[1];
  const amount       = amountMatch ? parseFloat(amountMatch.replace('.', '').replace(',', '.')) : null;
  const companyName  = text.match(/^##\s+(.+)$/m)?.[1]?.trim() || null;
  const vatNumber    = text.match(/P\.?\s*IVA[:\s]*([\d]{11})/i)?.[1] || null;
  const iban         = text.match(/IBAN[:\s]*([A-Z]{2}\d{2}[A-Z0-9]+)/i)?.[1] || null;
  return { invoice_number: invoiceNumber, invoice_date: invoiceDate, due_date: dueDate, amount, company_name: companyName, vat_number: vatNumber, iban, payment_terms: null };
}

export default async function scadenziarioRoutes(fastify, options) {
  // Middleware di autenticazione
  const preHandler = fastify.authenticate;

  // Endpoint per ottenere tutte le scadenze
  fastify.post('/list', { preHandler }, async (request, reply) => {
    try {
      const { db, filters = {} } = request.body;

      // Costruzione della query di base
      let queryText = `
        SELECT
          s.id,
          s.subject,
          s.description,
          s.causale,
          to_char(s.date, 'YYYY-MM-DD') AS date,
          s.amount,
          to_char(s.payment_date, 'YYYY-MM-DD') AS payment_date,
          s.status,
          o.name as owner_name,
          o.id as owner_id,
          s.type, s.alert_days, s.invoice_number,
          to_char(s.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          s.company_name, s.vat_number, s.iban, s.bank_name,
          s.payment_terms, s.attachment_url, s.group_id
        FROM
          scadenziario s
        LEFT JOIN
          owners o ON s.owner_id = o.id
        WHERE
          1=1
      `;
      
      // Array per i parametri della query
      const queryParams = [];
      
      // Aggiunta filtri alla query
      if (filters.subject) {
        queryParams.push(`%${filters.subject}%`);
        queryText += ` AND s.subject ILIKE $${queryParams.length}`;
      }
      
      if (filters.description) {
        queryParams.push(`%${filters.description}%`);
        queryText += ` AND s.description ILIKE $${queryParams.length}`;
      }
      
      if (filters.status && filters.status.length) {
        const statusPlaceholders = filters.status.map((_, index) => `$${queryParams.length + index + 1}`).join(', ');
        queryText += ` AND s.status IN (${statusPlaceholders})`;
        queryParams.push(...filters.status);
      }
      
      if (filters.startDate && filters.endDate) {
        queryParams.push(filters.startDate, filters.endDate);
        queryText += ` AND s.date BETWEEN $${queryParams.length - 1} AND $${queryParams.length}`;
      }
      
      // Filtro per proprietario specifico
      if (filters.ownerId) {
        queryParams.push(filters.ownerId);
        queryText += ` AND s.owner_id = $${queryParams.length}`;
      }

      // Filtro per tipo
      if (filters.type) {
        queryParams.push(filters.type);
        queryText += ` AND s.type = $${queryParams.length}`;
      }

      // Ordinamento e limite
      queryText += ` ORDER BY s.date ASC`;
      
      // Esecuzione query
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, queryParams);
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il recupero dei dati dello scadenziario:', error);
      reply.status(500).send({ 
        error: 'Errore durante il recupero dei dati dello scadenziario', 
        message: error.message 
      });
    }
  });

  // Endpoint per ottenere una scadenza specifica
  fastify.post('/details', { preHandler }, async (request, reply) => {
    try {
      const { db, id } = request.body;
      
      if (!id) {
        return reply.status(400).send({ error: 'ID non specificato' });
      }

      const queryText = `
        SELECT
          s.id,
          s.subject,
          s.description,
          s.causale,
          to_char(s.date, 'YYYY-MM-DD') AS date,
          s.amount,
          to_char(s.payment_date, 'YYYY-MM-DD') AS payment_date,
          s.status,
          o.name as owner_name,
          o.id as owner_id,
          s.type, s.alert_days, s.invoice_number,
          to_char(s.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          s.company_name, s.vat_number, s.iban, s.bank_name,
          s.payment_terms, s.attachment_url, s.group_id
        FROM
          scadenziario s
        LEFT JOIN
          owners o ON s.owner_id = o.id
        WHERE
          s.id = $1
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [id]);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il recupero dei dettagli della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante il recupero dei dettagli della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per creare una nuova scadenza
  fastify.post('/create', { preHandler }, async (request, reply) => {
    try {
      const { db, scadenza } = request.body;
      
      if (!scadenza) {
        return reply.status(400).send({ error: 'Dati della scadenza non specificati' });
      }

      const {
        subject,
        description,
        causale,
        date,
        amount,
        payment_date,
        status,
        owner_id,
        // nuovi campi
        type,
        alert_days,
        invoice_number,
        invoice_date,
        company_name,
        vat_number,
        iban,
        bank_name,
        payment_terms,
        attachment_url,
        group_id,
      } = scadenza;

      // Verifica dei campi obbligatori
      if (!subject || !date || amount === undefined || !status) {
        return reply.status(400).send({
          error: 'Campi obbligatori mancanti',
          message: 'I campi soggetto, data, importo e stato sono obbligatori'
        });
      }

      const queryText = `
        INSERT INTO scadenziario
          (subject, description, causale, date, amount, payment_date, status, owner_id,
           type, alert_days, invoice_number, invoice_date, company_name, vat_number,
           iban, bank_name, payment_terms, attachment_url, group_id)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING
          id,
          subject,
          description,
          causale,
          to_char(date, 'YYYY-MM-DD') AS date,
          amount,
          to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
          status,
          type, alert_days, invoice_number,
          to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
          company_name, vat_number, iban, bank_name,
          payment_terms, attachment_url, group_id
      `;

      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [
          subject,
          description || null,
          causale || null,
          date,
          amount,
          payment_date || null,
          status,
          owner_id || null,
          type || 'altro',
          alert_days || 15,
          invoice_number || null,
          invoice_date || null,
          company_name || null,
          vat_number || null,
          iban || null,
          bank_name || null,
          payment_terms ? JSON.stringify(payment_terms) : null,
          attachment_url || null,
          group_id || null,
        ]);
        
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante la creazione della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante la creazione della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per aggiornare una scadenza esistente
  fastify.post('/update', { preHandler }, async (request, reply) => {
    try {
      const { db, id, scadenza } = request.body;
      
      if (!id || !scadenza) {
        return reply.status(400).send({ error: 'ID o dati della scadenza non specificati' });
      }

      const {
        subject,
        description,
        causale,
        date,
        amount,
        payment_date,
        status,
        owner_id,
        // nuovi campi
        type,
        alert_days,
        invoice_number,
        invoice_date,
        company_name,
        vat_number,
        iban,
        bank_name,
        payment_terms,
        attachment_url,
        group_id,
      } = scadenza;

      // Costruzione della query di aggiornamento
      let updateFields = [];
      const queryParams = [id]; // Primo parametro è sempre l'ID
      let paramIndex = 2; // Inizia da 2 perché l'ID è $1

      if (subject !== undefined) {
        updateFields.push(`subject = $${paramIndex++}`);
        queryParams.push(subject);
      }

      if (description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        queryParams.push(description);
      }

      if (causale !== undefined) {
        updateFields.push(`causale = $${paramIndex++}`);
        queryParams.push(causale);
      }

      if (date !== undefined) {
        updateFields.push(`date = $${paramIndex++}`);
        queryParams.push(date);
      }

      if (amount !== undefined) {
        updateFields.push(`amount = $${paramIndex++}`);
        queryParams.push(amount);
      }

      if (payment_date !== undefined) {
        updateFields.push(`payment_date = $${paramIndex++}`);
        queryParams.push(payment_date);
      }

      if (status !== undefined) {
        updateFields.push(`status = $${paramIndex++}`);
        queryParams.push(status);
      }

      if (owner_id !== undefined) {
        updateFields.push(`owner_id = $${paramIndex++}`);
        queryParams.push(owner_id);
      }

      if (type !== undefined) {
        updateFields.push(`type = $${paramIndex++}`);
        queryParams.push(type);
      }

      if (alert_days !== undefined) {
        updateFields.push(`alert_days = $${paramIndex++}`);
        queryParams.push(alert_days);
      }

      if (invoice_number !== undefined) {
        updateFields.push(`invoice_number = $${paramIndex++}`);
        queryParams.push(invoice_number);
      }

      if (invoice_date !== undefined) {
        updateFields.push(`invoice_date = $${paramIndex++}`);
        queryParams.push(invoice_date);
      }

      if (company_name !== undefined) {
        updateFields.push(`company_name = $${paramIndex++}`);
        queryParams.push(company_name);
      }

      if (vat_number !== undefined) {
        updateFields.push(`vat_number = $${paramIndex++}`);
        queryParams.push(vat_number);
      }

      if (iban !== undefined) {
        updateFields.push(`iban = $${paramIndex++}`);
        queryParams.push(iban);
      }

      if (bank_name !== undefined) {
        updateFields.push(`bank_name = $${paramIndex++}`);
        queryParams.push(bank_name);
      }

      if (payment_terms !== undefined) {
        updateFields.push(`payment_terms = $${paramIndex++}`);
        queryParams.push(payment_terms ? JSON.stringify(payment_terms) : null);
      }

      if (attachment_url !== undefined) {
        updateFields.push(`attachment_url = $${paramIndex++}`);
        queryParams.push(attachment_url);
      }

      if (group_id !== undefined) {
        updateFields.push(`group_id = $${paramIndex++}`);
        queryParams.push(group_id);
      }
      
      if (updateFields.length === 0) {
        return reply.status(400).send({ error: 'Nessun campo da aggiornare' });
      }
      
      const queryText = `
        UPDATE scadenziario
        SET ${updateFields.join(', ')}
        WHERE id = $1
        RETURNING
          id,
          subject,
          description,
          causale,
          to_char(date, 'YYYY-MM-DD') AS date,
          amount,
          to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
          status,
          type, alert_days, invoice_number,
          to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
          company_name, vat_number, iban, bank_name,
          payment_terms, attachment_url, group_id
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, queryParams);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'aggiornamento della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per aggiornare solo lo stato del pagamento
  fastify.post('/update-payment', { preHandler }, async (request, reply) => {
    try {
      const { db, id, payment_date, status } = request.body;
      
      if (!id) {
        return reply.status(400).send({ error: 'ID non specificato' });
      }

      // Se lo stato è 'completed', impostiamo la data di pagamento se non fornita
      let paymentDate = payment_date;
      let paymentStatus = status || 'completed';
      
      if (paymentStatus === 'completed' && !paymentDate) {
        paymentDate = new Date().toISOString().substring(0, 10); // formato YYYY-MM-DD
      }

      // Se la data di pagamento è null, lo stato non può essere 'completed'
      if (!paymentDate && paymentStatus === 'completed') {
        paymentStatus = 'upcoming'; // default allo stato "in scadenza" se senza data
      }
      
      const queryText = `
        UPDATE scadenziario
        SET payment_date = $2, status = $3
        WHERE id = $1
        RETURNING 
          id, 
          subject, 
          description, 
          causale, 
          to_char(date, 'YYYY-MM-DD') AS date,
          amount,
          to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
          status
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [id, paymentDate, paymentStatus]);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento dello stato di pagamento:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'aggiornamento dello stato di pagamento', 
        message: error.message 
      });
    }
  });

  // Endpoint per eliminare una scadenza
  fastify.post('/delete', { preHandler }, async (request, reply) => {
    try {
      const { db, id } = request.body;
      
      if (!id) {
        return reply.status(400).send({ error: 'ID non specificato' });
      }

      const queryText = `
        DELETE FROM scadenziario
        WHERE id = $1
        RETURNING id
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [id]);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ success: true, message: 'Scadenza eliminata con successo' });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'eliminazione della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per eliminare più scadenze
  fastify.post('/delete-multiple', { preHandler }, async (request, reply) => {
    try {
      const { db, ids } = request.body;
      
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return reply.status(400).send({ error: 'Nessun ID specificato' });
      }

      // Costruzione dei parametri per la query
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
      const queryText = `
        DELETE FROM scadenziario
        WHERE id IN (${placeholders})
        RETURNING id
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, ids);
        
        reply.send({ 
          success: true, 
          message: `Eliminate ${result.rows.length} scadenze su ${ids.length} richieste` 
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione multipla delle scadenze:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'eliminazione multipla delle scadenze', 
        message: error.message 
      });
    }
  });

  // Endpoint per aggiornare automaticamente lo stato delle scadenze
  fastify.post('/update-status', { preHandler }, async (request, reply) => {
    try {
      const { db } = request.body;
      const today = new Date();
      const todayStr = today.toISOString().substring(0, 10); // YYYY-MM-DD
      
      // Data di 15 giorni nel futuro (per scadenze imminenti)
      const futureDate = new Date();
      futureDate.setDate(today.getDate() + 15);
      const futureDateStr = futureDate.toISOString().substring(0, 10);

      const client = await fastify.pg.pool.connect();
      try {
        // Aggiorna le scadenze scadute (senza data pagamento e data < oggi)
        await client.query(`
          UPDATE scadenziario
          SET status = 'overdue'
          WHERE payment_date IS NULL
          AND date < $1
        `, [todayStr]);
        
        // Aggiorna le scadenze imminenti (senza data pagamento, data >= oggi e <= oggi + 15 giorni)
        await client.query(`
          UPDATE scadenziario
          SET status = 'upcoming'
          WHERE payment_date IS NULL
          AND date >= $1
          AND date <= $2
        `, [todayStr, futureDateStr]);
        
        // Aggiorna le scadenze future (senza data pagamento, data > oggi + 15 giorni)
        await client.query(`
          UPDATE scadenziario
          SET status = 'future'
          WHERE payment_date IS NULL
          AND date > $1
        `, [futureDateStr]);
        
        // Tutte le scadenze con data di pagamento sono 'completed'
        await client.query(`
          UPDATE scadenziario
          SET status = 'completed'
          WHERE payment_date IS NOT NULL
        `);
        
        reply.send({ 
          success: true, 
          message: 'Stato delle scadenze aggiornato con successo' 
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento automatico degli stati:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'aggiornamento automatico degli stati', 
        message: error.message 
      });
    }
  });

  // Endpoint per ottenere i gruppi di rate di un owner
  fastify.post('/groups', { preHandler }, async (request, reply) => {
    try {
      const { db, owner_id } = request.body;
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(
          `SELECT * FROM scadenziario_groups WHERE owner_id = $1 ORDER BY created_at DESC`,
          [owner_id]
        );
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il recupero dei gruppi:', error);
      reply.status(500).send({ error: 'Errore durante il recupero dei gruppi', message: error.message });
    }
  });

  // Endpoint per creare un gruppo + N rate in una transazione
  fastify.post('/create-group', { preHandler }, async (request, reply) => {
    try {
      const { db, group, installments: installmentList } = request.body;
      const client = await fastify.pg.pool.connect();
      try {
        await client.query('BEGIN');

        const groupResult = await client.query(
          `INSERT INTO scadenziario_groups (name, type, total_amount, installments, frequency, start_date, owner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [group.name, group.type, group.total_amount, group.installments, group.frequency, group.start_date, group.owner_id]
        );
        const groupId = groupResult.rows[0].id;

        const inserted = [];
        for (const inst of installmentList) {
          const r = await client.query(
            `INSERT INTO scadenziario (subject, description, date, amount, status, owner_id, type, group_id, alert_days)
             VALUES ($1,$2,$3,$4,$5,$6,'rata',$7,$8) RETURNING *`,
            [inst.subject, inst.description || null, inst.date, inst.amount, inst.status || 'future', group.owner_id, groupId, group.alert_days || 15]
          );
          inserted.push(r.rows[0]);
        }

        await client.query('COMMIT');
        reply.send({ data: { group: groupResult.rows[0], installments: inserted }, success: true });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante la creazione del gruppo:', error);
      reply.status(500).send({ error: 'Errore durante la creazione del gruppo', message: error.message });
    }
  });

  // Endpoint per eliminare un gruppo (solo rate non pagate)
  fastify.post('/delete-group', { preHandler }, async (request, reply) => {
    try {
      const { db, group_id } = request.body;
      const client = await fastify.pg.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM scadenziario WHERE group_id = $1 AND status != 'completed'`,
          [group_id]
        );
        // Elimina il gruppo solo se non rimangono rate
        const remaining = await client.query(
          `SELECT COUNT(*) FROM scadenziario WHERE group_id = $1`,
          [group_id]
        );
        if (parseInt(remaining.rows[0].count, 10) === 0) {
          await client.query(`DELETE FROM scadenziario_groups WHERE id = $1`, [group_id]);
        }
        await client.query('COMMIT');
        reply.send({ success: true });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione del gruppo:', error);
      reply.status(500).send({ error: 'Errore durante l\'eliminazione del gruppo', message: error.message });
    }
  });

  // Endpoint OCR: estrae dati da PDF/immagine fattura via Docling
  fastify.post('/ocr-extract', { preHandler }, async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'Nessun file ricevuto' });

      const buffer = await data.toBuffer();
      const filename = data.filename || 'document.pdf';
      const ext = filename.split('.').pop()?.toLowerCase();
      const mimeTypes = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
      };
      const mimeType = mimeTypes[ext] || 'application/octet-stream';

      // Chiama Docling
      const params = new URLSearchParams({ do_ocr: 'true', do_table_structure: 'true', ocr_engine: 'tesseract', ocr_lang: 'ita' });
      const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
      const header = Buffer.from([
        `--${boundary}`,
        `Content-Disposition: form-data; name="files"; filename="${filename}"`,
        `Content-Type: ${mimeType}`,
        '',
        '',
      ].join('\r\n'));
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const formData = Buffer.concat([header, buffer, footer]);

      const doclingRes = await fetch(`${DOCLING_URL}/v1/convert/file?${params.toString()}`, {
        method: 'POST',
        body: formData,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        signal: AbortSignal.timeout(5 * 60 * 1000), // 5 minuti
      });

      if (!doclingRes.ok) {
        const errText = await doclingRes.text();
        return reply.status(502).send({ error: 'Docling error', message: errText });
      }

      const doclingData = await doclingRes.json();
      const text = doclingData.document?.md_content
        || doclingData.document?.text_content
        || doclingData.md_content
        || doclingData.text_content
        || '';

      // Log testo grezzo per debug
      console.log('[OCR] Testo estratto da Docling (primi 2000 caratteri):\n', text.substring(0, 2000));

      // Estrazione campi: prima copilot-bridge, fallback regex
      let fields = await extractInvoiceFieldsWithAI(text);
      if (!fields) fields = extractInvoiceFieldsWithRegex(text);

      reply.send({ data: fields });
    } catch (error) {
      console.error('Errore OCR extract:', error);
      reply.status(500).send({ error: 'Errore OCR extract', message: error.message });
    }
  });

  // Endpoint upload allegato su MinIO bucket scadenziario-attachments
  fastify.post('/upload-attachment', { preHandler }, async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'Nessun file ricevuto' });

      const { owner_id } = request.query;
      const buffer = await data.toBuffer();
      const ext = data.filename.split('.').pop();
      const objectName = `${owner_id || 'unknown'}/${new Date().getFullYear()}/${Date.now()}.${ext}`;

      const minioClient = createMinioClient();
      await ensureBucketExists(minioClient, MINIO_BUCKET_SCADENZIARIO);
      await minioClient.putObject(MINIO_BUCKET_SCADENZIARIO, objectName, buffer, buffer.length, {
        'Content-Type': data.mimetype,
      });

      const url = `/api/scadenziario/attachment/${encodeURIComponent(objectName)}`;
      reply.send({ data: { url, object_name: objectName } });
    } catch (error) {
      console.error('Errore upload allegato:', error);
      reply.status(500).send({ error: 'Errore upload allegato', message: error.message });
    }
  });

  // Endpoint per servire un allegato da MinIO
  fastify.get('/attachment/:objectName', { preHandler }, async (request, reply) => {
    try {
      const objectName = decodeURIComponent(request.params.objectName);
      const minioClient = createMinioClient();
      const stream = await minioClient.getObject(MINIO_BUCKET_SCADENZIARIO, objectName);
      reply.send(stream);
    } catch (error) {
      console.error('Errore recupero allegato:', error);
      reply.status(500).send({ error: 'Errore recupero allegato', message: error.message });
    }
  });
};
