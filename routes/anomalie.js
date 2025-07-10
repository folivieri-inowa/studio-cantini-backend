import { checkUserLogin } from '../lib/utils.js';

const anomalie = async (fastify) => {
  
  /**
   * GET /anomalie/analysis
   * Analizza le singole transazioni anomale per identificare movimenti che si discostano dalla media del soggetto
   * 
   * Query params:
   * - db: database di riferimento
   * - soglia: soglia percentuale per identificare anomalie (default: 50)
   * - mesi: numero di mesi da considerare per il calcolo della media (default: 12)
   * - limit: numero massimo di anomalie da restituire (default: 100)
   * - offset: offset per la paginazione (default: 0)
   * - tipo_anomalia: 'con_dettaglio', 'senza_dettaglio', 'tutte' (default: 'tutte')
   * - categoria_id: filtra per categoria specifica
   * - soggetto_id: filtra per soggetto specifico
   * - data_da: data di inizio per il filtro delle transazioni (YYYY-MM-DD)
   * - data_a: data di fine per il filtro delle transazioni (YYYY-MM-DD)
   * - soglia_minima: soglia minima di scostamento (default: 0)
   * - soglia_massima: soglia massima di scostamento (default: 1000)
   * - importo_minimo: importo minimo delle transazioni
   * - importo_massimo: importo massimo delle transazioni
   * - score_minimo: score minimo di criticità (0-100)
   * - ordine: 'score_desc', 'score_asc', 'data_desc', 'data_asc', 'importo_desc', 'importo_asc' (default: 'score_desc')
   */
  fastify.get('/analysis', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { 
        db, 
        soglia = 50, 
        mesi = 12, 
        limit = 100, 
        offset = 0,
        tipo_anomalia = 'tutte',
        categoria_id,
        soggetto_id,
        data_da,
        data_a,
        soglia_minima = 0,
        soglia_massima = 1000,
        importo_minimo,
        importo_massimo,
        score_minimo = 0,
        ordine = 'score_desc'
      } = request.query;

      if (!db) {
        return reply.code(400).send({ 
          message: 'Database parameter is required', 
          status: 400 
        });
      }

      // Validazione parametri
      const sogliaNum = parseFloat(soglia);
      const mesiNum = parseInt(mesi);
      const limitNum = parseInt(limit);
      const offsetNum = parseInt(offset);
      const sogliaMinimaNum = parseFloat(soglia_minima);
      const sogliaMassimaNum = parseFloat(soglia_massima);
      const scoreMinimo = parseFloat(score_minimo);

      if (isNaN(sogliaNum) || sogliaNum < 0 || sogliaNum > 100) {
        return reply.code(400).send({ 
          message: 'Soglia must be a number between 0 and 100', 
          status: 400 
        });
      }

      if (isNaN(mesiNum) || mesiNum < 1 || mesiNum > 60) {
        return reply.code(400).send({ 
          message: 'Mesi must be a number between 1 and 60', 
          status: 400 
        });
      }

      if (!['tutte', 'con_dettaglio', 'senza_dettaglio'].includes(tipo_anomalia)) {
        return reply.code(400).send({ 
          message: 'Tipo anomalia must be one of: tutte, con_dettaglio, senza_dettaglio', 
          status: 400 
        });
      }

      if (isNaN(scoreMinimo) || scoreMinimo < 0 || scoreMinimo > 100) {
        return reply.code(400).send({ 
          message: 'Score minimo must be a number between 0 and 100', 
          status: 400 
        });
      }

      // Calcola la data di inizio per il periodo di analisi
      const dataInizio = new Date();
      dataInizio.setMonth(dataInizio.getMonth() - mesiNum);

      // Costruisci i filtri
      const filtri = {
        tipo_anomalia,
        categoria_id: categoria_id ? parseInt(categoria_id) : null,
        soggetto_id: soggetto_id ? parseInt(soggetto_id) : null,
        data_da: data_da ? new Date(data_da) : null,
        data_a: data_a ? new Date(data_a) : null,
        soglia_minima: sogliaMinimaNum,
        soglia_massima: sogliaMassimaNum,
        importo_minimo: importo_minimo ? parseFloat(importo_minimo) : null,
        importo_massimo: importo_massimo ? parseFloat(importo_massimo) : null,
        score_minimo: scoreMinimo,
        ordine
      };

      // Trova le transazioni anomale per soggetto
      const anomalie = await analizzaTransazioniAnomale(
        fastify, 
        db, 
        dataInizio, 
        sogliaNum,
        filtri
      );

      // Applica paginazione
      const anomaliePaginate = anomalie.slice(offsetNum, offsetNum + limitNum);

      // Calcola statistiche
      const soggettiUnici = [...new Set(anomalie.map(a => a.soggetto_id))];
      const categorieUniche = [...new Set(anomalie.map(a => a.categoria_nome))];
      const statistiche = {
        totale_anomalie: anomalie.length,
        soggetti_con_anomalie: soggettiUnici.length,
        categorie_con_anomalie: categorieUniche.length,
        anomalie_per_soggetto: anomalie.length > 0 ? (anomalie.length / soggettiUnici.length).toFixed(1) : 0,
        scostamento_medio: anomalie.length > 0 ? 
          (anomalie.reduce((sum, a) => sum + a.percentuale_scostamento, 0) / anomalie.length).toFixed(1) : 0,
        scostamento_massimo: anomalie.length > 0 ? 
          Math.max(...anomalie.map(a => a.percentuale_scostamento)).toFixed(1) : 0,
        score_medio: anomalie.length > 0 ? 
          (anomalie.reduce((sum, a) => sum + a.score_criticita, 0) / anomalie.length).toFixed(1) : 0,
        score_massimo: anomalie.length > 0 ? 
          Math.max(...anomalie.map(a => a.score_criticita)).toFixed(1) : 0,
        con_dettaglio: anomalie.filter(a => a.tipo_transazione === 'con_dettaglio').length,
        senza_dettaglio: anomalie.filter(a => a.tipo_transazione === 'senza_dettaglio').length
      };

      reply.send({
        success: true,
        data: anomaliePaginate,
        statistiche,
        parametri: {
          soglia: sogliaNum,
          mesi: mesiNum,
          periodo_analisi: {
            da: dataInizio.toISOString().split('T')[0],
            a: new Date().toISOString().split('T')[0]
          },
          filtri_applicati: filtri
        },
        paginazione: {
          limite: limitNum,
          offset: offsetNum,
          totale: anomalie.length,
          ha_prossima_pagina: offsetNum + limitNum < anomalie.length
        }
      });

    } catch (error) {
      console.error('Errore nell\'analisi delle anomalie:', error);
      reply.status(500).send({ 
        success: false,
        error: 'Errore interno del server durante l\'analisi delle anomalie' 
      });
    }
  });

  /**
   * GET /anomalie/stats
   * Restituisce statistiche generali sulle anomalie
   */
  fastify.get('/stats', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, mesi = 12 } = request.query;

      if (!db) {
        return reply.code(400).send({ 
          message: 'Database parameter is required', 
          status: 400 
        });
      }

      const mesiNum = parseInt(mesi);
      const dataInizio = new Date();
      dataInizio.setMonth(dataInizio.getMonth() - mesiNum);

      // Statistiche generali
      const statsQuery = `
        SELECT 
          COUNT(DISTINCT categoryid) as categorie_totali,
          COUNT(DISTINCT subjectid) as soggetti_totali,
          COUNT(*) as transazioni_totali,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as spese_totali,
          AVG(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as spesa_media
        FROM transactions 
        WHERE db = $1 
          AND date >= $2 
          AND amount < 0
      `;

      const { rows: statsRows } = await fastify.pg.query(statsQuery, [db, dataInizio]);

      reply.send({
        success: true,
        data: statsRows[0],
        periodo_analisi: {
          da: dataInizio.toISOString().split('T')[0],
          a: new Date().toISOString().split('T')[0],
          mesi: mesiNum
        }
      });

    } catch (error) {
      console.error('Errore nel calcolo delle statistiche:', error);
      reply.status(500).send({ 
        success: false,
        error: 'Errore interno del server durante il calcolo delle statistiche' 
      });
    }
  });

  /**
   * GET /anomalie/filtri
   * Restituisce i dati per popolare i filtri (categorie, soggetti, etc.)
   */
  fastify.get('/filtri', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, mesi = 12 } = request.query;

      if (!db) {
        return reply.code(400).send({ 
          message: 'Database parameter is required', 
          status: 400 
        });
      }

      const mesiNum = parseInt(mesi);
      const dataInizio = new Date();
      dataInizio.setMonth(dataInizio.getMonth() - mesiNum);

      // Ottieni categorie con anomalie
      const categorieQuery = `
        SELECT DISTINCT c.id, c.name, COUNT(t.id) as transazioni_totali
        FROM categories c
        JOIN transactions t ON c.id = t.categoryid
        WHERE t.db = $1 AND t.date >= $2 AND t.amount < 0
        GROUP BY c.id, c.name
        ORDER BY c.name
      `;

      // Ottieni soggetti con anomalie
      const soggettiQuery = `
        SELECT DISTINCT s.id, s.name, COUNT(t.id) as transazioni_totali
        FROM subjects s
        JOIN transactions t ON s.id = t.subjectid
        WHERE t.db = $1 AND t.date >= $2 AND t.amount < 0
        GROUP BY s.id, s.name
        ORDER BY s.name
      `;

      // Ottieni range di importi
      const importiQuery = `
        SELECT 
          MIN(ABS(amount)) as importo_minimo,
          MAX(ABS(amount)) as importo_massimo,
          AVG(ABS(amount)) as importo_medio,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(amount)) as importo_mediano
        FROM transactions
        WHERE db = $1 AND date >= $2 AND amount < 0
      `;

      const [categorieResult, soggettiResult, importiResult] = await Promise.all([
        fastify.pg.query(categorieQuery, [db, dataInizio]),
        fastify.pg.query(soggettiQuery, [db, dataInizio]),
        fastify.pg.query(importiQuery, [db, dataInizio])
      ]);

      reply.send({
        success: true,
        data: {
          categorie: categorieResult.rows,
          soggetti: soggettiResult.rows,
          importi: importiResult.rows[0],
          periodo_analisi: {
            da: dataInizio.toISOString().split('T')[0],
            a: new Date().toISOString().split('T')[0]
          }
        }
      });

    } catch (error) {
      console.error('Errore nel recupero dei filtri:', error);
      reply.status(500).send({ 
        success: false,
        error: 'Errore interno del server durante il recupero dei filtri' 
      });
    }
  });
};

/**
 * Analizza le transazioni anomale per soggetto
 * Identifica le singole transazioni che si discostano significativamente dalla media del soggetto
 * Include filtri avanzati e calcolo del score di criticità
 */
async function analizzaTransazioniAnomale(fastify, db, dataInizio, soglia, filtri = {}) {
  // Costruisci le condizioni WHERE per i filtri
  const buildWhereConditions = (baseConditions, tableAlias = 't') => {
    let conditions = [...baseConditions];
    let params = [];
    
    if (filtri.categoria_id) {
      conditions.push(`${tableAlias}.categoryid = $${params.length + 4}`);
      params.push(filtri.categoria_id);
    }
    
    if (filtri.soggetto_id) {
      conditions.push(`${tableAlias}.subjectid = $${params.length + 4}`);
      params.push(filtri.soggetto_id);
    }
    
    if (filtri.data_da) {
      conditions.push(`${tableAlias}.date >= $${params.length + 4}`);
      params.push(filtri.data_da);
    }
    
    if (filtri.data_a) {
      conditions.push(`${tableAlias}.date <= $${params.length + 4}`);
      params.push(filtri.data_a);
    }
    
    if (filtri.importo_minimo) {
      conditions.push(`ABS(${tableAlias}.amount) >= $${params.length + 4}`);
      params.push(filtri.importo_minimo);
    }
    
    if (filtri.importo_massimo) {
      conditions.push(`ABS(${tableAlias}.amount) <= $${params.length + 4}`);
      params.push(filtri.importo_massimo);
    }
    
    return { conditions, params };
  };

  const baseConditions = [
    't.db = $1',
    't.date >= $2',
    't.amount < 0'
  ];

  const { conditions: whereConditions, params: extraParams } = buildWhereConditions(baseConditions);

  // Costruisci l'ORDER BY per l'ordinamento
  const buildOrderBy = () => {
    switch (filtri.ordine) {
      case 'score_asc':
        return 'score_criticita ASC';
      case 'data_desc':
        return 'date DESC';
      case 'data_asc':
        return 'date ASC';
      case 'importo_desc':
        return 'importo_assoluto DESC';
      case 'importo_asc':
        return 'importo_assoluto ASC';
      case 'score_desc':
      default:
        return 'score_criticita DESC';
    }
  };

  const query = `
    WITH media_per_gruppo AS (
      -- Media per soggetti CON dettaglio specifico (gruppo per soggetto+dettaglio)
      SELECT 
        s.id as soggetto_id,
        s.name as soggetto_nome,
        c.name as categoria_nome,
        d.id as dettaglio_id,
        d.name as dettaglio_nome,
        'con_dettaglio' as tipo_gruppo,
        AVG(ABS(t.amount)) as media_storica,
        STDDEV(ABS(t.amount)) as deviazione_standard,
        COUNT(*) as transazioni_storiche,
        COUNT(DISTINCT DATE_TRUNC('month', t.date)) as mesi_con_spese
      FROM transactions t
      JOIN subjects s ON t.subjectid = s.id
      JOIN categories c ON t.categoryid = c.id
      JOIN details d ON t.detailid = d.id
      WHERE ${whereConditions.join(' AND ')}
        AND t.detailid IS NOT NULL
      GROUP BY s.id, s.name, c.name, d.id, d.name
      HAVING COUNT(*) >= 3
      
      UNION ALL
      
      -- Media per soggetti SENZA dettaglio (gruppo per soggetto, escludendo transazioni con dettaglio)
      SELECT 
        s.id as soggetto_id,
        s.name as soggetto_nome,
        c.name as categoria_nome,
        NULL as dettaglio_id,
        NULL as dettaglio_nome,
        'senza_dettaglio' as tipo_gruppo,
        AVG(ABS(t.amount)) as media_storica,
        STDDEV(ABS(t.amount)) as deviazione_standard,
        COUNT(*) as transazioni_storiche,
        COUNT(DISTINCT DATE_TRUNC('month', t.date)) as mesi_con_spese
      FROM transactions t
      JOIN subjects s ON t.subjectid = s.id
      JOIN categories c ON t.categoryid = c.id
      WHERE ${whereConditions.join(' AND ')}
        AND t.detailid IS NULL
      GROUP BY s.id, s.name, c.name
      HAVING COUNT(*) >= 3
    ),
    transazioni_anomale AS (
      -- Transazioni CON dettaglio
      SELECT 
        t.id as transazione_id,
        t.date,
        t.amount,
        ABS(t.amount) as importo_assoluto,
        COALESCE(t.description, '') as descrizione,
        d.name as dettaglio,
        s.id as soggetto_id,
        s.name as soggetto_nome,
        c.name as categoria_nome,
        mpg.media_storica,
        mpg.deviazione_standard,
        mpg.transazioni_storiche,
        mpg.mesi_con_spese,
        'con_dettaglio' as tipo_transazione,
        CASE 
          WHEN mpg.media_storica > 0 THEN
            ROUND(((ABS(t.amount) - mpg.media_storica) / mpg.media_storica * 100)::numeric, 2)
          ELSE 0
        END as percentuale_scostamento,
        -- Calcolo score di criticità (0-100)
        CASE 
          WHEN mpg.media_storica > 0 THEN
            LEAST(100, GREATEST(0, 
              -- Componente scostamento (40% del peso)
              (ABS((ABS(t.amount) - mpg.media_storica) / mpg.media_storica * 100) * 0.4) +
              -- Componente importo assoluto (30% del peso) - normalizzato su scala 0-100
              (LEAST(100, ABS(t.amount) / 1000 * 100) * 0.3) +
              -- Componente frequenza/recency (20% del peso)
              (CASE 
                WHEN t.date >= CURRENT_DATE - INTERVAL '7 days' THEN 20
                WHEN t.date >= CURRENT_DATE - INTERVAL '30 days' THEN 15
                WHEN t.date >= CURRENT_DATE - INTERVAL '90 days' THEN 10
                ELSE 5
              END) +
              -- Componente variabilità (10% del peso)
              (CASE 
                WHEN mpg.deviazione_standard > 0 AND mpg.media_storica > 0 THEN
                  LEAST(10, (mpg.deviazione_standard / mpg.media_storica * 100 * 0.1))
                ELSE 0
              END)
            ))
          ELSE 0
        END as score_criticita
      FROM transactions t
      JOIN subjects s ON t.subjectid = s.id
      JOIN categories c ON t.categoryid = c.id
      JOIN details d ON t.detailid = d.id
      JOIN media_per_gruppo mpg ON s.id = mpg.soggetto_id 
        AND d.id = mpg.dettaglio_id 
        AND mpg.tipo_gruppo = 'con_dettaglio'
      WHERE ${whereConditions.join(' AND ')}
        AND t.detailid IS NOT NULL
        AND ABS(t.amount) > 0
        ${filtri.tipo_anomalia === 'senza_dettaglio' ? 'AND FALSE' : ''}
      
      UNION ALL
      
      -- Transazioni SENZA dettaglio
      SELECT 
        t.id as transazione_id,
        t.date,
        t.amount,
        ABS(t.amount) as importo_assoluto,
        COALESCE(t.description, '') as descrizione,
        NULL as dettaglio,
        s.id as soggetto_id,
        s.name as soggetto_nome,
        c.name as categoria_nome,
        mpg.media_storica,
        mpg.deviazione_standard,
        mpg.transazioni_storiche,
        mpg.mesi_con_spese,
        'senza_dettaglio' as tipo_transazione,
        CASE 
          WHEN mpg.media_storica > 0 THEN
            ROUND(((ABS(t.amount) - mpg.media_storica) / mpg.media_storica * 100)::numeric, 2)
          ELSE 0
        END as percentuale_scostamento,
        -- Calcolo score di criticità (0-100)
        CASE 
          WHEN mpg.media_storica > 0 THEN
            LEAST(100, GREATEST(0, 
              -- Componente scostamento (40% del peso)
              (ABS((ABS(t.amount) - mpg.media_storica) / mpg.media_storica * 100) * 0.4) +
              -- Componente importo assoluto (30% del peso) - normalizzato su scala 0-100
              (LEAST(100, ABS(t.amount) / 1000 * 100) * 0.3) +
              -- Componente frequenza/recency (20% del peso)
              (CASE 
                WHEN t.date >= CURRENT_DATE - INTERVAL '7 days' THEN 20
                WHEN t.date >= CURRENT_DATE - INTERVAL '30 days' THEN 15
                WHEN t.date >= CURRENT_DATE - INTERVAL '90 days' THEN 10
                ELSE 5
              END) +
              -- Componente variabilità (10% del peso)
              (CASE 
                WHEN mpg.deviazione_standard > 0 AND mpg.media_storica > 0 THEN
                  LEAST(10, (mpg.deviazione_standard / mpg.media_storica * 100 * 0.1))
                ELSE 0
              END)
            ))
          ELSE 0
        END as score_criticita
      FROM transactions t
      JOIN subjects s ON t.subjectid = s.id
      JOIN categories c ON t.categoryid = c.id
      JOIN media_per_gruppo mpg ON s.id = mpg.soggetto_id 
        AND mpg.tipo_gruppo = 'senza_dettaglio'
      WHERE ${whereConditions.join(' AND ')}
        AND t.detailid IS NULL
        AND ABS(t.amount) > 0
        ${filtri.tipo_anomalia === 'con_dettaglio' ? 'AND FALSE' : ''}
    )
    SELECT *
    FROM transazioni_anomale
    WHERE ABS(percentuale_scostamento) >= $3
      AND ABS(percentuale_scostamento) BETWEEN ${filtri.soglia_minima} AND ${filtri.soglia_massima}
      AND score_criticita >= ${filtri.score_minimo}
    ORDER BY ${buildOrderBy()}
  `;

  const { rows } = await fastify.pg.query(query, [
    db, 
    dataInizio, 
    soglia,
    ...extraParams
  ]);

  return rows.map(row => ({
    tipo: 'transazione',
    transazione_id: row.transazione_id,
    data: row.date,
    importo: parseFloat(row.amount),
    importo_assoluto: parseFloat(row.importo_assoluto),
    descrizione: row.descrizione || '',
    dettaglio: row.dettaglio || '',
    soggetto_id: row.soggetto_id,
    soggetto_nome: row.soggetto_nome,
    categoria_nome: row.categoria_nome,
    media_storica: parseFloat(row.media_storica),
    deviazione_standard: parseFloat(row.deviazione_standard) || 0,
    transazioni_storiche: parseInt(row.transazioni_storiche),
    mesi_con_spese: parseInt(row.mesi_con_spese),
    tipo_transazione: row.tipo_transazione,
    percentuale_scostamento: Math.abs(parseFloat(row.percentuale_scostamento)),
    direzione: row.percentuale_scostamento > 0 ? 'superiore' : 'inferiore',
    score_criticita: Math.round(parseFloat(row.score_criticita) || 0),
    // Categorie di criticità per UI
    livello_criticita: getLivelloCriticita(parseFloat(row.score_criticita) || 0)
  }));
}

/**
 * Determina il livello di criticità basato sul score
 */
function getLivelloCriticita(score) {
  if (score >= 80) return 'critico';
  if (score >= 60) return 'alto';
  if (score >= 40) return 'medio';
  if (score >= 20) return 'basso';
  return 'molto_basso';
}

export default anomalie;
