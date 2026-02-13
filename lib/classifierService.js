/**
 * Classification Service - Auto-classificazione transazioni
 * 
 * Pipeline a 4 stage con fallback graduali:
 * 1. Rule-based (fast, high confidence)
 * 2. Historical exact match (PostgreSQL similarity)
 * 3. Semantic vector search (Qdrant + embeddings)
 * 4. Manual review (fallback UI)
 * 
 * @module classifierService
 */

import { QdrantClient } from '@qdrant/js-client-rest';
// Node.js 18+ ha fetch nativo

// ==========================================
// CONFIGURATION
// ==========================================

function getConfig() {
  return {
    qdrant: {
      url: process.env.QDRANT_URL || 'http://qdrant:6333',
      apiKey: process.env.QDRANT_API_KEY || '',
    },
    ollama: {
      url: process.env.OLLAMA_URL || 'http://ollama:11434',
      model: process.env.EMBEDDING_MODEL || 'bge-m3',
    },
    thresholds: {
      // Confidence thresholds per stage
      ruleConfidenceMin: 95,
      exactConfidenceMin: 85,
      semanticConfidenceMin: 70,
      
      // Similarity thresholds (abbassati perché ora usiamo descrizioni normalizzate)
      textSimilarityMin: 0.75, // Era 0.85, ora più basso perché normalizziamo
      vectorSimilarityMin: 0.82,
      amountProximityMin: 0.70,
      
      // Scoring weights
      weights: {
        // STAGE 2: Exact match
        exact: {
          textSimilarity: 0.50,
          amountProximity: 0.30,
          recency: 0.10,
          frequency: 0.10,
        },
        // STAGE 3: Semantic search
        semantic: {
          vectorScore: 0.40,
          amountScore: 0.30,
          recencyScore: 0.15,
          frequencyScore: 0.15,
        }
      }
    }
  };
}

// Qdrant client con lazy initialization
let qdrantClient = null;
function getQdrantClient() {
  if (!qdrantClient) {
    const config = getConfig();
    qdrantClient = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
      checkCompatibility: false,
    });
  }
  return qdrantClient;
}

// ==========================================
// RETRY & ERROR HANDLING UTILITIES
// ==========================================

/**
 * Retry function con exponential backoff
 * @param {Function} fn - Async function da eseguire
 * @param {number} maxRetries - Numero massimo di tentativi (default: 3)
 * @param {number} baseDelay - Delay iniziale in ms (default: 1000)
 * @returns {Promise<any>} - Risultato della funzione
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff: 1s, 2s, 4s
        console.warn(`[Retry] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Controlla lo stato dei servizi esterni
 * @returns {Promise<object>} - Status dei servizi
 */
export async function checkServicesHealth() {
  const config = getConfig();
  const results = {
    postgres: { status: 'unknown', latency_ms: null },
    qdrant: { status: 'unknown', latency_ms: null, error: null },
    ollama: { status: 'unknown', latency_ms: null, error: null },
  };

  // 1. Qdrant health check
  try {
    const qdrantStart = Date.now();
    const client = getQdrantClient();
    await client.getCollections();
    results.qdrant.status = 'healthy';
    results.qdrant.latency_ms = Date.now() - qdrantStart;
  } catch (error) {
    results.qdrant.status = 'unhealthy';
    results.qdrant.error = error.message;
  }

  // 2. Ollama health check
  try {
    const ollamaStart = Date.now();
    const response = await fetch(`${config.ollama.url}/api/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000), // 5s timeout
    });
    
    if (response.ok) {
      results.ollama.status = 'healthy';
      results.ollama.latency_ms = Date.now() - ollamaStart;
    } else {
      results.ollama.status = 'unhealthy';
      results.ollama.error = `HTTP ${response.status}`;
    }
  } catch (error) {
    results.ollama.status = 'unhealthy';
    results.ollama.error = error.message;
  }

  // Determina capabilities disponibili
  const capabilities = {
    rule_based: true, // Always available (no external deps)
    exact_match: true, // Always available (Postgres)
    semantic_search: results.qdrant.status === 'healthy' && results.ollama.status === 'healthy',
    indexing: results.qdrant.status === 'healthy' && results.ollama.status === 'healthy',
  };

  return {
    services: results,
    capabilities,
    overall_status: 
      results.qdrant.status === 'healthy' && results.ollama.status === 'healthy' 
        ? 'healthy' 
        : results.qdrant.status === 'unhealthy' || results.ollama.status === 'unhealthy'
        ? 'degraded'
        : 'unknown',
  };
}

// ==========================================
// TYPES & INTERFACES
// ==========================================

/**
 * @typedef {Object} Transaction
 * @property {string} id - UUID transazione
 * @property {string} description - Descrizione transazione
 * @property {number} amount - Importo (positivo/negativo)
 * @property {string} date - Data ISO string
 * @property {string} paymentType - Tipo pagamento
 * @property {string} ownerId - ID proprietario conto
 */

/**
 * @typedef {Object} ClassificationResult
 * @property {boolean} success
 * @property {Object|null} classification
 * @property {string} classification.category_id
 * @property {string} classification.category_name
 * @property {string} classification.subject_id
 * @property {string} classification.subject_name
 * @property {string|null} classification.detail_id
 * @property {string|null} classification.detail_name
 * @property {number} classification.confidence - 0-100
 * @property {string} classification.method - 'rule' | 'exact' | 'semantic' | 'manual'
 * @property {string} classification.reasoning
 * @property {Array<Object>} [suggestions] - Alternative classificazioni
 * @property {boolean} needs_review
 * @property {number} latency_ms
 */

// ==========================================
// MAIN CLASSIFICATION FUNCTION
// ==========================================

/**
 * Classifica una transazione usando pipeline a 4 stage
 * 
 * @param {Transaction} transaction - Transazione da classificare
 * @param {string} db - Database ID
 * @param {Object} pg - PostgreSQL client (Fastify instance)
 * @returns {Promise<ClassificationResult>}
 */
export async function classifyTransaction(transaction, db, pg) {
  const startTime = Date.now();
  
  try {
    // STAGE 1: Rule-based fast path
    const ruleMatch = await checkRules(transaction, db, pg);
    if (ruleMatch) {
      return formatResult(ruleMatch, startTime, false);
    }
    
    // STAGE 2: Historical exact match
    const exactMatch = await findHistoricalMatch(transaction, db, pg);
    if (exactMatch) {
      return formatResult(exactMatch, startTime, false);
    }
    
    // STAGE 3: Semantic vector search
    const semanticResult = await semanticSearch(transaction, db, pg);
    
    // Se confidence >= threshold, ritorna classificazione
    if (semanticResult.classification && !semanticResult.needs_review) {
      return formatResult(semanticResult.classification, startTime, false, semanticResult.suggestions);
    }

    // STAGE 3.5: Entity matching fallback (dopo la semantica, per evitare falsi positivi generici)
    const entityMatch = await findEntityMatch(transaction, db, pg);
    if (entityMatch) {
      return formatResult(entityMatch, startTime, false, semanticResult.suggestions);
    }
    
    // STAGE 4: Manual review (ritorna suggestions)
    return {
      success: true,
      classification: null,
      suggestions: semanticResult.suggestions || [],
      needs_review: true,
      latency_ms: Date.now() - startTime,
    };
    
  } catch (error) {
    console.error('[ClassifierService] Error:', error);
    return {
      success: false,
      error: error.message,
      needs_review: true,
      latency_ms: Date.now() - startTime,
    };
  }
}

// ==========================================
// STAGE 1: RULE-BASED CLASSIFIER
// ==========================================

/**
 * Controlla se la transazione matcha una regola definita
 * 
 * @param {Transaction} transaction
 * @param {string} db
 * @param {Object} pg - PostgreSQL client
 * @returns {Promise<Object|null>}
 */
async function checkRules(transaction, db, pg) {
  const query = `
    SELECT 
      id,
      rule_name,
      description_patterns,
      amount_min,
      amount_max,
      payment_types,
      category_id,
      subject_id,
      detail_id,
      confidence,
      reasoning
    FROM classification_rules
    WHERE db = $1 
      AND enabled = true
    ORDER BY priority DESC
  `;
  
  const result = await pg.query(query, [db]);
  const rules = result.rows;
  
  console.log(`[STAGE 1: Rule] Checking ${rules.length} rules for transaction ${transaction.id} (db: ${db})`);
  console.log(`[STAGE 1: Rule] Description: "${transaction.description}", Amount: ${transaction.amount}`);
  
  for (const rule of rules) {
    // Test description patterns (regex)
    if (rule.description_patterns && rule.description_patterns.length > 0) {
      const patternMatch = rule.description_patterns.some(pattern => {
        try {
          const regex = new RegExp(pattern, 'i');
          return regex.test(transaction.description);
        } catch (e) {
          console.warn(`[Rule ${rule.id}] Invalid regex pattern:`, pattern);
          return false;
        }
      });
      
      if (!patternMatch) continue;
    }
    
    // Test amount range
    const absAmount = Math.abs(transaction.amount);
    if (rule.amount_min !== null && absAmount < rule.amount_min) continue;
    if (rule.amount_max !== null && absAmount > rule.amount_max) continue;
    
    // Test payment types
    if (rule.payment_types && rule.payment_types.length > 0) {
      if (!rule.payment_types.includes(transaction.paymentType)) continue;
    }
    
    // Match trovato!
    console.log(`[STAGE 1: Rule] Match regola "${rule.rule_name}" per transazione ${transaction.id}`);
    
    // Fetch nomi categoria/soggetto/dettaglio
    const namesQuery = `
      SELECT 
        c.id as category_id, c.name as category_name,
        s.id as subject_id, s.name as subject_name,
        d.id as detail_id, d.name as detail_name
      FROM categories c
      JOIN subjects s ON s.id = $2
      LEFT JOIN details d ON d.id = $3
      WHERE c.id = $1
    `;
    
    const namesResult = await pg.query(namesQuery, [
      rule.category_id,
      rule.subject_id,
      rule.detail_id
    ]);
    
    if (namesResult.rows.length === 0) {
      console.warn(`[Rule ${rule.id}] Invalid category/subject/detail IDs`);
      continue;
    }
    
    const names = namesResult.rows[0];
    
    return {
      category_id: names.category_id,
      category_name: names.category_name,
      subject_id: names.subject_id,
      subject_name: names.subject_name,
      detail_id: names.detail_id,
      detail_name: names.detail_name,
      confidence: rule.confidence,
      method: 'rule',
      reasoning: rule.reasoning || `Match regola: ${rule.rule_name}`,
    };
  }
  
  return null; // Nessuna regola matchata
}

// ==========================================
// STAGE 1.5: ENTITY MATCHING
// ==========================================

/**
 * Cerca nomi di categorie, soggetti o dettagli nella descrizione della transazione
 * Utile quando la descrizione menziona esplicitamente l'entità (es. "ORLANDO ANNAMARIA", "AGSM", "Canone locazione")
 * 
 * @param {Transaction} transaction
 * @param {string} db
 * @param {Object} pg - PostgreSQL client
 * @returns {Promise<Object|null>}
 */
async function findEntityMatch(transaction, db, pg) {
  const descLower = transaction.description.toLowerCase();
  const amountRange = transaction.amount * 0.15; // ±15% tolleranza
  
  // Cerca combinazioni frequenti di category+subject+detail che appaiono nella descrizione
  // Priorità: nomi più lunghi (più specifici) e combinazioni più frequenti
  const query = `
    WITH entity_stats AS (
      SELECT 
        cf.corrected_category_id,
        cf.corrected_subject_id,
        cf.corrected_detail_id,
        c.name as category_name,
        s.name as subject_name,
        d.name as detail_name,
        COUNT(*) as usage_count,
        -- Calcola similarità importo rispetto alle transazioni precedenti
        AVG(
          CASE 
            WHEN ABS(cf.amount - $2) <= $3 THEN 1.0
            WHEN ABS(cf.amount) < 1 OR ABS($2) < 1 THEN 0.7
            ELSE GREATEST(0, 1.0 - ABS(cf.amount - $2) / GREATEST(ABS(cf.amount), ABS($2)))
          END
        ) as avg_amount_similarity
      FROM classification_feedback cf
      JOIN categories c ON cf.corrected_category_id = c.id AND c.db = $1
      JOIN subjects s ON cf.corrected_subject_id = s.id AND s.db = $1
      LEFT JOIN details d ON cf.corrected_detail_id = d.id AND d.db = $1
      WHERE cf.db = $1
        AND cf.created_at > NOW() - INTERVAL '12 months'
      GROUP BY 
        cf.corrected_category_id,
        cf.corrected_subject_id,
        cf.corrected_detail_id,
        c.name, s.name, d.name
      HAVING COUNT(*) >= 1  -- Richiedi almeno 1 utilizzo storico
    )
    SELECT 
      corrected_category_id as category_id,
      corrected_subject_id as subject_id,
      corrected_detail_id as detail_id,
      category_name,
      subject_name,
      detail_name,
      usage_count,
      avg_amount_similarity,
      -- Calcola match score basato sulla lunghezza e posizione del nome nella descrizione
      CASE
        WHEN LOWER(subject_name) = $4 THEN 100  -- Match esatto soggetto
        WHEN LOWER(detail_name) = $4 THEN 95    -- Match esatto dettaglio
        WHEN LENGTH(subject_name) >= 8 THEN LENGTH(subject_name) * 3  -- Nome lungo = più specifico
        WHEN LENGTH(detail_name) >= 8 THEN LENGTH(detail_name) * 2.5
        ELSE LENGTH(COALESCE(subject_name, '')) * 2
      END as name_length_score
    FROM entity_stats
    WHERE 
      -- Cerca subject nella descrizione (minimo 3 caratteri per evitare falsi positivi)
      (LENGTH(subject_name) >= 3 AND POSITION(LOWER(subject_name) IN $4) > 0)
      OR
      -- O cerca detail nella descrizione  
      (detail_name IS NOT NULL AND LENGTH(detail_name) >= 3 AND POSITION(LOWER(detail_name) IN $4) > 0)
    ORDER BY 
      name_length_score DESC,
      usage_count DESC,
      avg_amount_similarity DESC
    LIMIT 1
  `;
  
  const result = await pg.query(query, [
    db,
    transaction.amount,
    amountRange,
    descLower
  ]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const match = result.rows[0];
  
  // Calcola confidence basandosi su:
  // - Lunghezza nome (più lungo = più specifico = più confidence)
  // - Frequenza utilizzo (più usato = più confidence)
  // - Similarità importo
  const nameScore = Math.min(40, match.name_length_score);
  const frequencyScore = Math.min(30, match.usage_count * 3);
  const amountScore = match.avg_amount_similarity * 30;
  
  const confidence = Math.round(nameScore + frequencyScore + amountScore);
  
  // Richiedi almeno 80% confidence per auto-classificare con questo metodo
  if (confidence < 80) {
    console.log(`[Entity Match] Found entity but confidence too low: ${confidence}%`);
    return null;
  }
  
  console.log(`[Entity Match] Found entity match with ${confidence}% confidence`);
  console.log(`  Matched entity: ${match.subject_name}`);
  console.log(`  Category: ${match.category_name}`);
  console.log(`  Usage count: ${match.usage_count}`);
  console.log(`  Amount similarity: ${(match.avg_amount_similarity * 100).toFixed(1)}%`);
  
  return {
    category_id: match.category_id,
    category_name: match.category_name,
    subject_id: match.subject_id,
    subject_name: match.subject_name,
    detail_id: match.detail_id,
    detail_name: match.detail_name,
    confidence,
    method: 'entity_match',
    reasoning: `Rilevato "${match.subject_name}" nella descrizione (usato ${match.usage_count} volte)`,
    debug: {
      matched_entity: match.subject_name || match.detail_name,
      usage_count: match.usage_count,
      avg_amount_similarity: match.avg_amount_similarity,
      name_score: nameScore,
      frequency_score: frequencyScore,
      amount_score: amountScore
    }
  };
}

// ==========================================
// STAGE 2: HISTORICAL EXACT MATCH
// ==========================================

/**
 * Cerca match esatti nello storico usando text similarity + amount proximity
 * 
 * @param {Transaction} transaction
 * @param {string} db
 * @param {Object} pg
 * @returns {Promise<Object|null>}
 */
async function findHistoricalMatch(transaction, db, pg) {
  const amountMin = transaction.amount * 0.8;
  const amountMax = transaction.amount * 1.2;
  const absAmount = Math.abs(transaction.amount);
  
  // Strategia a doppio livello:
  // 1. Prima prova con descrizione ORIGINALE (threshold alto 0.85)
  // 2. Se non trova nulla, prova con descrizione NORMALIZZATA (threshold più basso 0.70)
  
  const config = getConfig();
  const weights = config.thresholds.weights.exact;
  
  // LIVELLO 1: Descrizione originale (per catturare match con numeri di carte/conti specifici)
  let result = await pg.query(`
    WITH scored_feedback AS (
      SELECT 
        cf.corrected_category_id,
        cf.corrected_subject_id,
        cf.corrected_detail_id,
        c.name as category_name,
        s.name as subject_name,
        d.name as detail_name,
        
        -- Text similarity su descrizione ORIGINALE
        similarity(lower(cf.original_description), lower($2)) as text_similarity,
        
        -- Amount proximity (logarithmic scale)
        CASE 
          WHEN cf.amount BETWEEN $3 AND $4 THEN 1.0
          WHEN ABS(cf.amount) < 1 OR $5::numeric < 1 THEN 0.5
          ELSE 1.0 - LEAST(1.0, ABS(LN(ABS(cf.amount)) - LN($5::numeric)) / 3.0)
        END as amount_proximity,
        
        -- Recency score
        1.0 - LEAST(1.0, EXTRACT(EPOCH FROM (NOW() - cf.created_at)) / (86400.0 * 180.0)) as recency_score,
        
        -- Frequency score
        (
          SELECT LEAST(1.0, COUNT(*)::float / 10.0)
          FROM classification_feedback cf2
          WHERE cf2.db = cf.db
            AND cf2.corrected_category_id = cf.corrected_category_id
            AND cf2.corrected_subject_id = cf.corrected_subject_id
            AND (cf2.corrected_detail_id = cf.corrected_detail_id OR (cf2.corrected_detail_id IS NULL AND cf.corrected_detail_id IS NULL))
        ) as frequency_score,
        
        cf.original_description as matched_description,
        cf.amount as matched_amount
        
      FROM classification_feedback cf
      JOIN categories c ON cf.corrected_category_id = c.id
      JOIN subjects s ON cf.corrected_subject_id = s.id
      LEFT JOIN details d ON cf.corrected_detail_id = d.id
      WHERE cf.db = $1
        AND similarity(lower(cf.original_description), lower($2)) > 0.85
        AND cf.created_at > NOW() - INTERVAL '6 months'
    )
    SELECT 
      *,
      (text_similarity * $6 + 
       amount_proximity * $7 + 
       recency_score * $8 +
       frequency_score * $9) as combined_score
    FROM scored_feedback
    WHERE text_similarity >= 0.85
      AND amount_proximity >= $10
    ORDER BY combined_score DESC
    LIMIT 1
  `, [
    db,
    transaction.description,
    amountMin,
    amountMax,
    absAmount,
    weights.textSimilarity,
    weights.amountProximity,
    weights.recency,
    weights.frequency,
    config.thresholds.amountProximityMin,
  ]);
  
  // Se trovato con descrizione originale, ritorna subito
  if (result.rows.length > 0) {
    const match = result.rows[0];
    const confidence = Math.round(match.combined_score * 100);
    
    console.log(`[Exact Match - Original] Found match with ${confidence}% confidence`);
    console.log(`  Text similarity: ${(match.text_similarity * 100).toFixed(1)}%`);
    console.log(`  Amount proximity: ${(match.amount_proximity * 100).toFixed(1)}%`);
    
    if (confidence >= config.thresholds.exactConfidenceMin) {
      return {
        category_id: match.corrected_category_id,
        category_name: match.category_name,
        subject_id: match.corrected_subject_id,
        subject_name: match.subject_name,
        detail_id: match.corrected_detail_id,
        detail_name: match.detail_name,
        confidence,
        method: 'exact',
        reasoning: `Match esatto storico (${(match.text_similarity * 100).toFixed(0)}% similarity)`,
        debug: {
          text_similarity: match.text_similarity,
          amount_proximity: match.amount_proximity,
          recency_score: match.recency_score,
          frequency_score: match.frequency_score,
          matched_description: match.matched_description,
          matched_amount: match.matched_amount,
          match_type: 'original_description'
        }
      };
    }
  }
  
  // LIVELLO 2: Descrizione NORMALIZZATA (fallback per catturare varianti con RIF: diversi)
  const normalizedDescription = normalizeDescription(transaction.description);
  
  result = await pg.query(`
    WITH scored_feedback AS (
      SELECT 
        cf.corrected_category_id,
        cf.corrected_subject_id,
        cf.corrected_detail_id,
        c.name as category_name,
        s.name as subject_name,
        d.name as detail_name,
        
        -- Text similarity su descrizioni NORMALIZZATE (rimuove RIF:, date, etc.)
        similarity(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  lower(cf.original_description),
                  '\\brif\\s*[:.]?\\s*\\d+', '', 'gi'
                ),
                '\\b\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}\\b', '', 'g'
              ),
              '\\bben\\.\\s*', '', 'gi'
            ),
            '\\s+', ' ', 'g'
          ),
          $2
        ) as text_similarity,
        
        -- Amount proximity
        CASE 
          WHEN cf.amount BETWEEN $3 AND $4 THEN 1.0
          WHEN ABS(cf.amount) < 1 OR $5::numeric < 1 THEN 0.5
          ELSE 1.0 - LEAST(1.0, ABS(LN(ABS(cf.amount)) - LN($5::numeric)) / 3.0)
        END as amount_proximity,
        
        -- Recency score
        1.0 - LEAST(1.0, EXTRACT(EPOCH FROM (NOW() - cf.created_at)) / (86400.0 * 180.0)) as recency_score,
        
        -- Frequency score
        (
          SELECT LEAST(1.0, COUNT(*)::float / 10.0)
          FROM classification_feedback cf2
          WHERE cf2.db = cf.db
            AND cf2.corrected_category_id = cf.corrected_category_id
            AND cf2.corrected_subject_id = cf.corrected_subject_id
            AND (cf2.corrected_detail_id = cf.corrected_detail_id OR (cf2.corrected_detail_id IS NULL AND cf.corrected_detail_id IS NULL))
        ) as frequency_score,
        
        cf.original_description as matched_description,
        cf.amount as matched_amount
        
      FROM classification_feedback cf
      JOIN categories c ON cf.corrected_category_id = c.id
      JOIN subjects s ON cf.corrected_subject_id = s.id
      LEFT JOIN details d ON cf.corrected_detail_id = d.id
      WHERE cf.db = $1
        AND similarity(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  lower(cf.original_description),
                  '\\brif\\s*[:.]?\\s*\\d+', '', 'gi'
                ),
                '\\b\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}\\b', '', 'g'
              ),
              '\\bben\\.\\s*', '', 'gi'
            ),
            '\\s+', ' ', 'g'
          ),
          $2
        ) > 0.70
        AND cf.created_at > NOW() - INTERVAL '6 months'
    )
    SELECT 
      *,
      (text_similarity * $6 + 
       amount_proximity * $7 + 
       recency_score * $8 +
       frequency_score * $9) as combined_score
    FROM scored_feedback
    WHERE text_similarity >= 0.70
      AND amount_proximity >= $10
    ORDER BY combined_score DESC
    LIMIT 1
  `, [
    db,
    normalizedDescription,
    amountMin,
    amountMax,
    absAmount,
    weights.textSimilarity,
    weights.amountProximity,
    weights.recency,
    weights.frequency,
    config.thresholds.amountProximityMin,
  ]);
  
  if (result.rows.length > 0) {
    const match = result.rows[0];
    // Cap confidence a 92% per match normalizzati (erano simili ma non identici)
    const confidence = Math.min(92, Math.round(match.combined_score * 100));
    
    if (confidence >= config.thresholds.exactConfidenceMin) {
      console.log(`[Exact Match - Normalized] Found match with ${confidence}% confidence`);
      console.log(`  Text similarity (normalized): ${(match.text_similarity * 100).toFixed(1)}%`);
      console.log(`  Amount proximity: ${(match.amount_proximity * 100).toFixed(1)}%`);
      
      return {
        category_id: match.corrected_category_id,
        category_name: match.category_name,
        subject_id: match.corrected_subject_id,
        subject_name: match.subject_name,
        detail_id: match.corrected_detail_id,
        detail_name: match.detail_name,
        confidence,
        method: 'exact',
        reasoning: `Match storico normalizzato (${(match.text_similarity * 100).toFixed(0)}% similarity)`,
        debug: {
          text_similarity: match.text_similarity,
          amount_proximity: match.amount_proximity,
          recency_score: match.recency_score,
          frequency_score: match.frequency_score,
          matched_description: match.matched_description,
          matched_amount: match.matched_amount,
          match_type: 'normalized_description'
        }
      };
    }
  }
  
  // LIVELLO 3: Token matching intelligente  
  // Quando le descrizioni hanno formati completamente diversi, cerchiamo overlap di nomi/aziende
  console.log(`[Token Match] Attempting token-based matching...`);
  
  const tokens = extractSignificantTokens(transaction.description);
  
  if (tokens.length === 0) {
    console.log(`[Token Match] No significant tokens found in description`);
    return null;
  }
  
  console.log(`[Token Match] Extracted ${tokens.length} tokens: ${tokens.join(', ')}`);
  
  // Cerca transazioni che contengono almeno 2 di questi token
  // Costruisci condizioni ILIKE per ogni token
  const tokenConditions = tokens.map((_, idx) => 
    `lower(cf.original_description) LIKE $${12 + idx}`
  ).join(' OR ');
  
  const tokenParams = tokens.map(token => `%${token}%`);
  
  result = await pg.query(`
    WITH token_matches AS (
      SELECT 
        cf.corrected_category_id,
        cf.corrected_subject_id,
        cf.corrected_detail_id,
        c.name as category_name,
        s.name as subject_name,
        d.name as detail_name,
        
        -- Conta quanti token matchano
        (
          ${tokens.map((_, idx) => 
            `CASE WHEN lower(cf.original_description) LIKE $${12 + idx} THEN 1 ELSE 0 END`
          ).join(' + ')}
        ) as token_overlap,
        
        -- Amount proximity
        CASE 
          WHEN cf.amount BETWEEN $3 AND $4 THEN 1.0
          WHEN ABS(cf.amount) < 1 OR $5::numeric < 1 THEN 0.5
          ELSE 1.0 - LEAST(1.0, ABS(LN(ABS(cf.amount)) - LN($5::numeric)) / 3.0)
        END as amount_proximity,
        
        -- Recency score
        1.0 - LEAST(1.0, EXTRACT(EPOCH FROM (NOW() - cf.created_at)) / (86400.0 * 180.0)) as recency_score,
        
        -- Frequency score
        (
          SELECT LEAST(1.0, COUNT(*)::float / 10.0)
          FROM classification_feedback cf2
          WHERE cf2.db = cf.db
            AND cf2.corrected_category_id = cf.corrected_category_id
            AND cf2.corrected_subject_id = cf.corrected_subject_id
        ) as frequency_score,
        
        cf.original_description as matched_description,
        cf.amount as matched_amount
        
      FROM classification_feedback cf
      JOIN categories c ON cf.corrected_category_id = c.id
      JOIN subjects s ON cf.corrected_subject_id = s.id
      LEFT JOIN details d ON cf.corrected_detail_id = d.id
      WHERE cf.db = $1
        AND $2::text IS NOT NULL
        AND $6::float8 >= 0
        AND $7::float8 >= 0
        AND $8::float8 >= 0
        AND $9::float8 >= 0
        AND (${tokenConditions})
        AND cf.created_at > NOW() - INTERVAL '12 months'
    )
    SELECT 
      *,
      -- Token overlap pesa 40%, amount 35%, recency 15%, frequency 10%
      (
        (token_overlap::float / $11::float) * 0.40 +
        amount_proximity * 0.35 +
        recency_score * 0.15 +
        frequency_score * 0.10
      ) as combined_score
    FROM token_matches
    WHERE token_overlap >= 1  -- Richiedi almeno 1 token significativo in comune
      AND amount_proximity >= $10
    ORDER BY combined_score DESC, token_overlap DESC
    LIMIT 1
  `, [
    db,
    transaction.description,
    amountMin,
    amountMax,
    absAmount,
    weights.textSimilarity,
    weights.amountProximity,
    weights.recency,
    weights.frequency,
    config.thresholds.amountProximityMin,
    tokens.length, // Numero totale di token per calcolare la percentuale
    ...tokenParams
  ]);
  
  if (result.rows.length === 0) {
    console.log(`[Token Match] No matches found with sufficient token overlap`);
    return null;
  }
  
  const match = result.rows[0];
  // Cap confidence a 88% per token matching (meno preciso dei metodi precedenti)
  const tokenOverlapPct = (match.token_overlap / tokens.length * 100).toFixed(0);
  const confidence = Math.min(88, Math.round(match.combined_score * 100));
  
  if (confidence < config.thresholds.exactConfidenceMin) {
    console.log(`[Token Match] Confidence too low: ${confidence}%`);
    return null;
  }
  
  console.log(`[Token Match] Found match with ${confidence}% confidence`);
  console.log(`  Token overlap: ${match.token_overlap}/${tokens.length} (${tokenOverlapPct}%)`);
  console.log(`  Amount proximity: ${(match.amount_proximity * 100).toFixed(1)}%`);
  console.log(`  Matched: "${match.matched_description}"`);
  
  return {
    category_id: match.corrected_category_id,
    category_name: match.category_name,
    subject_id: match.corrected_subject_id,
    subject_name: match.subject_name,
    detail_id: match.corrected_detail_id,
    detail_name: match.detail_name,
    confidence,
    method: 'feedback_learning',
    reasoning: `Match per token comuni (${match.token_overlap}/${tokens.length} token, ${tokenOverlapPct}%)`,
    debug: {
      token_overlap: match.token_overlap,
      total_tokens: tokens.length,
      matched_tokens_pct: tokenOverlapPct,
      amount_proximity: match.amount_proximity,
      recency_score: match.recency_score,
      frequency_score: match.frequency_score,
      matched_description: match.matched_description,
      matched_amount: match.matched_amount,
      match_type: 'token_overlap'
    }
  };
}

// ==========================================
// STAGE 3: SEMANTIC VECTOR SEARCH
// ==========================================

/**
 * Ricerca semantica usando Qdrant + embeddings
 * 
 * @param {Transaction} transaction
 * @param {string} db
 * @param {Object} pg
 * @returns {Promise<Object>}
 */
async function semanticSearch(transaction, db, pg) {
  const qdrantClient = getQdrantClient();
  const config = getConfig();
  
  // 1. Genera embedding
  const amountBucket = getAmountBucket(transaction.amount);
  const embeddingText = `${transaction.description} | Importo: ${amountBucket} (${getAmountRange(amountBucket)})`;
  
  let embedding;
  try {
    embedding = await generateEmbedding(embeddingText);
  } catch (error) {
    console.error('[STAGE 3: Semantic] Embedding generation failed:', error);
    return { suggestions: [], needs_review: true };
  }
  
  // 2. Query Qdrant con retry
  let searchResults;
  try {
    searchResults = await retryWithBackoff(async () => {
      return await qdrantClient.search(`transactions_${db}`, {
        vector: embedding,
        limit: 12,
        score_threshold: config.thresholds.vectorSimilarityMin,
        filter: {
          must: [
            { key: 'db', match: { value: db } }
          ]
        },
      });
    }, 3, 1000);
  } catch (error) {
    console.error('[STAGE 3: Semantic] Qdrant search failed after retries:', error);
    return { suggestions: [], needs_review: true };
  }
  
  if (searchResults.length === 0) {
    console.log(`[STAGE 3: Semantic] Nessun risultato trovato per transazione ${transaction.id}`);
    return { suggestions: [], needs_review: true };
  }
  
  console.log(`[STAGE 3: Semantic] Trovati ${searchResults.length} risultati per transazione ${transaction.id}`);
  
  // 3. Re-rank con score composito
  const weights = config.thresholds.weights.semantic;
  const now = new Date();
  
  const scoredResults = searchResults.map(result => {
    const payload = result.payload;
    
    // Vector similarity (già fornito da Qdrant)
    const vectorScore = result.score;
    
    // Amount proximity
    const amountScore = calculateAmountProximity(
      transaction.amount,
      payload.amount
    );
    
    // Recency score
    const transDate = new Date(payload.transaction_date);
    const ageMonths = monthsDiff(transDate, now);
    const recencyScore = Math.max(0, 1 - (ageMonths / 12));
    
    // Frequency score
    const frequencyScore = Math.min(1, (payload.classification_frequency || 0) / 20);
    
    // Composite score
    const compositeScore = 
      vectorScore * weights.vectorScore +
      amountScore * weights.amountScore +
      recencyScore * weights.recencyScore +
      frequencyScore * weights.frequencyScore;
    
    return {
      ...payload,
      vectorScore,
      amountScore,
      recencyScore,
      frequencyScore,
      compositeScore,
    };
  });
  
  // 4. Ordina per composite score
  scoredResults.sort((a, b) => b.compositeScore - a.compositeScore);
  
  // 5. Raggruppa per (category, subject, detail)
  const clusters = groupByCategorization(scoredResults);
  
  // 6. Calcola cluster confidence
  const rankedClusters = clusters.map(cluster => {
    const avgScore = cluster.items.reduce((sum, item) => sum + item.compositeScore, 0) / cluster.items.length;
    const clusterSize = cluster.items.length;
    const topScore = cluster.items[0].compositeScore;
    
    // Cluster confidence: dimensione + qualità score + top result
    const clusterConfidence = (
      avgScore * 0.50 +
      (clusterSize / scoredResults.length) * 0.30 +
      topScore * 0.20
    ) * 100;
    
    return {
      category_id: cluster.category_id,
      category_name: cluster.category_name,
      subject_id: cluster.subject_id,
      subject_name: cluster.subject_name,
      detail_id: cluster.detail_id,
      detail_name: cluster.detail_name,
      confidence: Math.round(clusterConfidence),
      clusterSize,
      avgScore: avgScore,
      similar_transactions: cluster.items.slice(0, 3).map(item => ({
        description: item.description,
        amount: item.amount,
        date: item.transaction_date,
        vector_score: Math.round(item.vectorScore * 100),
        amount_score: Math.round(item.amountScore * 100),
        composite_score: Math.round(item.compositeScore * 100),
      })),
      reasoning: `Cluster di ${clusterSize} transazioni simili (score medio: ${Math.round(avgScore * 100)}%)`,
    };
  });
  
  // 7. Ordina cluster per confidence
  rankedClusters.sort((a, b) => b.confidence - a.confidence);
  
  // 8. Decisione finale
  const bestCluster = rankedClusters[0];
  
  if (bestCluster.confidence >= config.thresholds.semanticConfidenceMin) {
    console.log(`[STAGE 3: Semantic] Auto-classify con confidence ${bestCluster.confidence}% per transazione ${transaction.id}`);
    
    return {
      classification: {
        category_id: bestCluster.category_id,
        category_name: bestCluster.category_name,
        subject_id: bestCluster.subject_id,
        subject_name: bestCluster.subject_name,
        detail_id: bestCluster.detail_id,
        detail_name: bestCluster.detail_name,
        confidence: bestCluster.confidence,
        method: 'semantic',
        reasoning: bestCluster.reasoning,
        similar_transactions: bestCluster.similar_transactions,
      },
      suggestions: rankedClusters.slice(1, 3), // Alternative
      needs_review: false,
    };
  } else {
    console.log(`[STAGE 3: Semantic] Confidence troppo bassa (${bestCluster.confidence}%), richiesta review manuale`);
    
    return {
      classification: null,
      suggestions: rankedClusters.slice(0, 3),
      needs_review: true,
    };
  }
}

// ==========================================
// EMBEDDING GENERATION
// ==========================================

/**
 * Genera embedding usando Ollama
 * 
 * @param {string} text - Testo da embeddare
 * @returns {Promise<number[]>} - Vector embedding
 */
async function generateEmbedding(text) {
  const config = getConfig();
  
  // Usa retry con exponential backoff (3 tentativi: 1s, 2s, 4s)
  return await retryWithBackoff(async () => {
    const response = await fetch(`${config.ollama.url}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        prompt: text,
      }),
      signal: AbortSignal.timeout(30000), // 30s timeout
    });
    
    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.embedding;
  }, 3, 1000);
}

// ==========================================
// BATCH INDEXING
// ==========================================

/**
 * Re-indicizza tutte le transazioni classificate in Qdrant
 * 
 * @param {string} db - Database ID
 * @param {Object} pg - PostgreSQL client
 * @param {number} limit - Max transazioni da indicizzare
 * @returns {Promise<Object>}
 */
export async function reindexTransactions(db, pg, limit = 5000) {
  console.log(`[Reindex] Avvio re-indicizzazione per ${db} (limit: ${limit})`);
  
  const qdrantClient = getQdrantClient();
  
  // 1. Fetch transazioni classificate
  const query = `
    SELECT 
      t.id,
      t.description,
      t.amount,
      t.date as transaction_date,
      t.paymenttype,
      t.categoryid,
      c.name as category_name,
      t.subjectid,
      s.name as subject_name,
      t.detailid,
      d.name as detail_name,
      COUNT(*) OVER (
        PARTITION BY t.categoryid, t.subjectid, t.detailid
      ) as classification_frequency
    FROM transactions t
    JOIN categories c ON t.categoryid = c.id
    JOIN subjects s ON t.subjectid = s.id
    LEFT JOIN details d ON t.detailid = d.id
    WHERE t.db = $1
      AND t.categoryid IS NOT NULL
      AND t.subjectid IS NOT NULL
      AND t.status = 'completed'
    ORDER BY t.date DESC
    LIMIT $2
  `;
  
  const result = await pg.query(query, [db, limit]);
  const transactions = result.rows;
  
  console.log(`[Reindex] Trovate ${transactions.length} transazioni da indicizzare`);
  
  // 2. Ricrea collection Qdrant
  try {
    await qdrantClient.deleteCollection(`transactions_${db}`);
  } catch (e) {
    // Collection potrebbe non esistere
  }
  
  await qdrantClient.createCollection(`transactions_${db}`, {
    vectors: {
      size: 1024, // bge-m3
      distance: 'Cosine',
    },
  });
  
  console.log(`[Reindex] Collection transactions_${db} creata`);
  
  // 3. Batch embedding + upload
  const batchSize = 10;
  let indexed = 0;
  
  for (let i = 0; i < transactions.length; i += batchSize) {
    const batch = transactions.slice(i, i + batchSize);
    
    // Genera embeddings in parallelo
    const embeddingsPromises = batch.map(t => {
      const amountBucket = getAmountBucket(t.amount);
      const embeddingText = `${t.description} | Importo: ${amountBucket} (${getAmountRange(amountBucket)})`;
      return generateEmbedding(embeddingText);
    });
    
    const embeddings = await Promise.all(embeddingsPromises);
    
    // Prepara punti per Qdrant
    const points = batch.map((t, idx) => ({
      id: t.id,
      vector: embeddings[idx],
      payload: {
        transaction_id: t.id,
        db: db,
        description: t.description,
        amount: parseFloat(t.amount),
        amount_bucket: getAmountBucket(t.amount),
        transaction_date: t.transaction_date,
        payment_type: t.paymenttype,
        category_id: t.categoryid,
        category_name: t.category_name,
        subject_id: t.subjectid,
        subject_name: t.subject_name,
        detail_id: t.detailid,
        detail_name: t.detail_name,
        embedding_text: `${t.description} | Importo: ${getAmountBucket(t.amount)}`,
        indexed_at: new Date().toISOString(),
        classification_frequency: parseInt(t.classification_frequency) || 0,
      },
    }));
    
    // Upload batch a Qdrant
    await qdrantClient.upsert(`transactions_${db}`, {
      wait: true,
      points,
    });
    
    indexed += batch.length;
    console.log(`[Reindex] Indicizzate ${indexed}/${transactions.length} transazioni`);
  }
  
  return {
    success: true,
    indexed_count: indexed,
    collection: `transactions_${db}`,
  };
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Calcola prossimità tra due importi (scala logaritmica)
 */
function calculateAmountProximity(amount1, amount2) {
  const amt1 = Math.abs(amount1);
  const amt2 = Math.abs(amount2);
  
  if (amt1 < 1 || amt2 < 1) return 0.5;
  
  const diff = Math.abs(Math.log(amt1) - Math.log(amt2));
  return Math.max(0, 1 - (diff / 3));
}

/**
 * Raggruppa risultati per (category, subject, detail)
 */
function groupByCategorization(results) {
  const clusters = new Map();
  
  for (const result of results) {
    const key = `${result.category_id}|${result.subject_id}|${result.detail_id || 'null'}`;
    
    if (!clusters.has(key)) {
      clusters.set(key, {
        category_id: result.category_id,
        category_name: result.category_name,
        subject_id: result.subject_id,
        subject_name: result.subject_name,
        detail_id: result.detail_id,
        detail_name: result.detail_name,
        items: [],
      });
    }
    
    clusters.get(key).items.push(result);
  }
  
  return Array.from(clusters.values());
}

/**
 * Calcola differenza in mesi tra due date
 */
function monthsDiff(date1, date2) {
  const months = (date2.getFullYear() - date1.getFullYear()) * 12 + 
                 (date2.getMonth() - date1.getMonth());
  return Math.max(0, months);
}

/**
 * Determina bucket importo
 */
function getAmountBucket(amount) {
  const abs = Math.abs(amount);
  if (abs <= 10) return 'micro';
  if (abs <= 50) return 'small';
  if (abs <= 150) return 'medium';
  if (abs <= 500) return 'large';
  return 'xlarge';
}

/**
 * Ottieni range testuale per bucket
 */
function getAmountRange(bucket) {
  const ranges = {
    'micro': '0-10€',
    'small': '10-50€',
    'medium': '50-150€',
    'large': '150-500€',
    'xlarge': '500+€',
  };
  return ranges[bucket] || '';
}

/**
 * Normalizza descrizione transazione per similarity search (CONSERVATIVO)
 * Rimuove SOLO pattern generici bancari, NON numeri identificativi del beneficiario
 * 
 * IMPORTANTE: Non rimuovere numeri di:
 * - Carte prepagate (es. "Postepay 4023600000000000")  
 * - Conti correnti (es. "Bonifico c/c 12345")
 * - Codici cliente/contratto (es. "ENEL contratto 123456")
 * 
 * Rimuove SOLO:
 * - RIF: operazione bancaria (RIF:149304229, Rif. 12345)
 * - Date (15/01/2025, del 15.01.2025)
 * - Timestamp operazioni (08:14, operazione carta 04035323 del...)
 * 
 * Esempi:
 * "Disposizione - RIF:149304229BEN. ORLANDO ANNAMARIA Ricarica postapay"
 * → "orlando annamaria ricarica postapay"
 * 
 * "Ricarica Postepay 4023600000000000 - Annamaria Orlando"
 * → "ricarica postepay 4023600000000000 annamaria orlando" (MANTIENE numero carta!)
 */
function normalizeDescription(description) {
  if (!description) return '';
  
  let normalized = description;
  
  // 1. Converti in lowercase
  normalized = normalized.toLowerCase();
  
  // 2. Rimuovi SOLO numeri di riferimento operazione bancaria (non numeri identificativi)
  // RIF:xxxxxx, Rif. xxxxxx (riferimento operazione)
  normalized = normalized.replace(/\brif\s*[:.]?\s*\d+/gi, '');
  // Protocollo operazione
  normalized = normalized.replace(/\bprot(?:ocol+o)?\s*[:.]?\s*\d+/gi, '');
  
  // 3. Rimuovi date nelle frasi (ma NON singoli numeri che potrebbero essere conti/carte)
  // Solo date con separatori evidenti: 15/01/2025, 15.01.2025
  normalized = normalized.replace(/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/g, '');
  normalized = normalized.replace(/\b\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}\b/g, '');
  // Frasi tipo "del 15/01/2025"
  normalized = normalized.replace(/\bdel\s+\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/gi, '');
  
  // 4. Rimuovi prefissi comuni bancari (ma mantieni il tipo operazione)
  normalized = normalized.replace(/^disposizione\s*-?\s*/i, '');
  
  // 5. Rimuovi timestamp e ore (hh:mm, hh:mm:ss)
  normalized = normalized.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '');
  
  // 6. Rimuovi "operazione carta XXXXX del DD/MM/YYYY" (codice operazione temporaneo)
  normalized = normalized.replace(/operazione\s+carta\s+\d{5,10}\s+del\s+\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/gi, '');
  
  // 7. Rimuovi pattern "VS FATTURA NR xxx DEL xxx"
  normalized = normalized.replace(/\bvs\s+fattura\s+n(?:r|um)?\s*\.?\s*\d+\s+del\s+\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/gi, '');
  
  // 8. Rimuovi "BEN." che è un'abbreviazione bancaria comune
  normalized = normalized.replace(/\bben\.\s*/gi, '');
  
  // 9. Rimuovi punctuation eccessiva e multipli spazi
  normalized = normalized.replace(/[\.,:;]+/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ');
  normalized = normalized.trim();
  
  return normalized;
}

/**
 * Estrae token significativi dalla descrizione (nomi, aziende, parole chiave)
 * Usato per matching quando le descrizioni hanno formati completamente diversi
 * 
 * @param {string} description - Descrizione transazione
 * @returns {string[]} - Array di token significativi (lowercase)
 */
function extractSignificantTokens(description) {
  if (!description) return [];
  
  const normalized = normalizeDescription(description);
  const words = normalized.split(/\s+/);
  
  // Stopwords comuni da ignorare
  const stopwords = new Set([
    'di', 'da', 'a', 'per', 'con', 'su', 'in', 'tra', 'fra', 'il', 'lo', 'la', 'i', 'gli', 'le',
    'un', 'uno', 'una', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'al', 'allo', 'alla',
    'ai', 'agli', 'alle', 'dal', 'dallo', 'dalla', 'dai', 'dagli', 'dalle', 'nel', 'nello',
    'nella', 'nei', 'negli', 'nelle', 'sul', 'sullo', 'sulla', 'sui', 'sugli', 'sulle', 'e', 'ed',
    'che', 'chi', 'cui', 'dove', 'quando', 'come', 'quanto', 'quale', 'cosa',
    'disposizione', 'bonifico', 'bancomat', 'pagamento', 'addebito', 'accredito', 'giroconto',
    'eur', 'euro', 'saldo', 'fattura', 'vostra', 'nostra', 'del', 'nr', 'num', 'numero',
    'spese', 'commissioni', 'canone', 'rata', 'acconto'
  ]);
  
  // Estrai parole significative (>=3 caratteri, non stopwords, non solo numeri)
  const tokens = words.filter(word => {
    return word.length >= 3 &&
           !stopwords.has(word) &&
           !/^\d+$/.test(word); // Non solo numeri
  });
  
  return [...new Set(tokens)]; // Rimuovi duplicati
}

/**
 * Indicizza singola transazione in Qdrant (per apprendimento real-time)
 * Chiamata dopo che l'utente classifica una transazione
 * 
 * @param {string} transactionId - UUID transazione
 * @param {string} db - Database ID
 * @param {Object} pg - PostgreSQL client
 * @returns {Promise<Object>}
 */
export async function indexSingleTransaction(transactionId, db, pg) {
  console.log(`[Index Single] Indicizzazione transazione ${transactionId} per apprendimento`);
  
  const qdrantClient = getQdrantClient();
  
  // 1. Fetch dati transazione dal DB
  const query = `
    SELECT 
      t.id,
      t.description,
      t.amount,
      t.date as transaction_date,
      t.paymenttype,
      t.categoryid,
      c.name as category_name,
      t.subjectid,
      s.name as subject_name,
      t.detailid,
      d.name as detail_name,
      COUNT(*) OVER (
        PARTITION BY t.categoryid, t.subjectid, t.detailid
      ) as classification_frequency
    FROM transactions t
    JOIN categories c ON t.categoryid = c.id
    JOIN subjects s ON t.subjectid = s.id
    LEFT JOIN details d ON t.detailid = d.id
    WHERE t.id = $1
      AND t.db = $2
      AND t.categoryid IS NOT NULL
      AND t.subjectid IS NOT NULL
      AND t.status = 'completed'
  `;
  
  const result = await pg.query(query, [transactionId, db]);
  
  if (result.rows.length === 0) {
    throw new Error(`Transazione ${transactionId} non trovata o non classificata`);
  }
  
  const transaction = result.rows[0];
  
  // 2. Genera embedding
  const amountBucket = getAmountBucket(transaction.amount);
  const embeddingText = `${transaction.description} | Importo: ${amountBucket} (${getAmountRange(amountBucket)})`;
  const embedding = await generateEmbedding(embeddingText);
  
  // 3. Prepara point per Qdrant
  const point = {
    id: transaction.id,
    vector: embedding,
    payload: {
      transaction_id: transaction.id,
      db: db,
      description: transaction.description,
      amount: parseFloat(transaction.amount),
      amount_bucket: amountBucket,
      transaction_date: transaction.transaction_date,
      payment_type: transaction.paymenttype,
      category_id: transaction.categoryid,
      category_name: transaction.category_name,
      subject_id: transaction.subjectid,
      subject_name: transaction.subject_name,
      detail_id: transaction.detailid,
      detail_name: transaction.detail_name,
      embedding_text: embeddingText,
      indexed_at: new Date().toISOString(),
      classification_frequency: parseInt(transaction.classification_frequency) || 0,
    },
  };
  
  // 4. Upsert in Qdrant (crea collection se non esiste)
  const collectionName = `transactions_${db}`;
  
  try {
    // Verifica se collection esiste
    await qdrantClient.getCollection(collectionName);
  } catch (e) {
    // Collection non esiste, creala
    console.log(`[Index Single] Collection ${collectionName} non esiste, creo nuova collection`);
    await qdrantClient.createCollection(collectionName, {
      vectors: {
        size: 1024, // bge-m3
        distance: 'Cosine',
      },
    });
  }
  
  // Upsert point (sovrascrive se esiste già)
  await qdrantClient.upsert(collectionName, {
    wait: true,
    points: [point],
  });
  
  console.log(`[Index Single] ✅ Transazione ${transactionId} indicizzata con successo`);
  
  return {
    success: true,
    transaction_id: transactionId,
    collection: collectionName,
    indexed_at: new Date().toISOString(),
  };
}

/**
 * Indicizza batch di transazioni in Qdrant (ottimizzato per multi-classify)
 * Genera embeddings in parallelo e fa bulk upsert
 * 
 * @param {string[]} transactionIds - Array di UUIDs transazioni
 * @param {string} db - Database ID
 * @param {Object} pg - PostgreSQL client
 * @returns {Promise<Object>}
 */
export async function indexBatchTransactions(transactionIds, db, pg) {
  const startTime = Date.now();
  console.log(`[Index Batch] Avvio indicizzazione batch di ${transactionIds.length} transazioni`);
  
  if (transactionIds.length === 0) {
    return {
      success: true,
      indexed_count: 0,
      skipped_count: 0,
      latency_ms: Date.now() - startTime,
    };
  }
  
  const qdrantClient = getQdrantClient();
  const collectionName = `transactions_${db}`;
  
  // 1. Fetch tutte le transazioni dal DB in una query
  const placeholders = transactionIds.map((_, i) => `$${i + 2}`).join(',');
  const query = `
    SELECT 
      t.id,
      t.description,
      t.amount,
      t.date as transaction_date,
      t.paymenttype,
      t.categoryid,
      c.name as category_name,
      t.subjectid,
      s.name as subject_name,
      t.detailid,
      d.name as detail_name,
      COUNT(*) OVER (
        PARTITION BY t.categoryid, t.subjectid, t.detailid
      ) as classification_frequency
    FROM transactions t
    JOIN categories c ON t.categoryid = c.id
    JOIN subjects s ON t.subjectid = s.id
    LEFT JOIN details d ON t.detailid = d.id
    WHERE t.id IN (${placeholders})
      AND t.db = $1
      AND t.categoryid IS NOT NULL
      AND t.subjectid IS NOT NULL
      AND t.status = 'completed'
  `;
  
  const result = await pg.query(query, [db, ...transactionIds]);
  const transactions = result.rows;
  
  if (transactions.length === 0) {
    console.log(`[Index Batch] Nessuna transazione valida trovata`);
    return {
      success: true,
      indexed_count: 0,
      skipped_count: transactionIds.length,
      latency_ms: Date.now() - startTime,
    };
  }
  
  console.log(`[Index Batch] Trovate ${transactions.length}/${transactionIds.length} transazioni classificate`);
  
  // 2. Genera embeddings in parallelo (batch processing)
  const embeddingPromises = transactions.map(t => {
    const amountBucket = getAmountBucket(t.amount);
    const embeddingText = `${t.description} | Importo: ${amountBucket} (${getAmountRange(amountBucket)})`;
    return generateEmbedding(embeddingText);
  });
  
  let embeddings;
  try {
    embeddings = await Promise.all(embeddingPromises);
    console.log(`[Index Batch] Generati ${embeddings.length} embeddings in parallelo`);
  } catch (error) {
    console.error('[Index Batch] Embedding generation failed:', error);
    throw error;
  }
  
  // 3. Verifica/Crea collection se non esiste
  try {
    await qdrantClient.getCollection(collectionName);
  } catch (e) {
    console.log(`[Index Batch] Collection ${collectionName} non esiste, creo nuova collection`);
    await qdrantClient.createCollection(collectionName, {
      vectors: {
        size: 1024, // bge-m3
        distance: 'Cosine',
      },
    });
  }
  
  // 4. Prepara punti per bulk upsert
  const points = transactions.map((t, idx) => {
    const amountBucket = getAmountBucket(t.amount);
    return {
      id: t.id,
      vector: embeddings[idx],
      payload: {
        transaction_id: t.id,
        db: db,
        description: t.description,
        amount: parseFloat(t.amount),
        amount_bucket: amountBucket,
        transaction_date: t.transaction_date,
        payment_type: t.paymenttype,
        category_id: t.categoryid,
        category_name: t.category_name,
        subject_id: t.subjectid,
        subject_name: t.subject_name,
        detail_id: t.detailid,
        detail_name: t.detail_name,
        embedding_text: `${t.description} | Importo: ${amountBucket}`,
        indexed_at: new Date().toISOString(),
        classification_frequency: parseInt(t.classification_frequency) || 0,
      },
    };
  });
  
  // 5. Bulk upsert a Qdrant
  await qdrantClient.upsert(collectionName, {
    wait: true,
    points,
  });
  
  const latency = Date.now() - startTime;
  console.log(`[Index Batch] ✅ ${transactions.length} transazioni indicizzate in ${latency}ms (~${Math.round(latency / transactions.length)}ms/txn)`);
  
  return {
    success: true,
    indexed_count: transactions.length,
    skipped_count: transactionIds.length - transactions.length,
    collection: collectionName,
    latency_ms: latency,
    avg_latency_per_transaction_ms: Math.round(latency / transactions.length),
  };
}

/**
 * Formatta risultato finale
 */
function formatResult(classification, startTime, needsReview = false, suggestions = []) {
  return {
    success: true,
    classification,
    suggestions,
    needs_review: needsReview,
    latency_ms: Date.now() - startTime,
  };
}

/**
 * Formatta currency (helper)
 */
function formatCurrency(amount) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount);
}
/**
 * Analizza feedback classificazioni e suggerisce nuove regole
 * 
 * Logica:
 * 1. Raggruppa feedback per pattern di descrizione (prime 3-4 parole)
 * 2. Identifica pattern con alta frequenza (>=10 occorrenze)
 * 3. Calcola consistenza classificazione (% stesso category/subject)
 * 4. Esclude pattern già coperti da regole esistenti
 * 5. Ritorna suggerimenti con esempi e statistiche
 * 
 * @param {string} db - Database name
 * @param {object} pg - Postgres pool
 * @param {number} minOccurrences - Minimo numero occorrenze (default: 10)
 * @param {number} minConsistency - Minima consistenza % (default: 80)
 * @returns {Promise<object>} { suggestions: [...], stats: {...} }
 */
export async function analyzeFeedbackPatterns(db, pg, minOccurrences = 3, minConsistency = 0.70) {
  const startTime = Date.now();

  try {
    // 1. Estrai pattern comuni da feedback (raggruppa per prime parole chiave)
    const patternsQuery = `
      WITH feedback_patterns AS (
        SELECT 
          -- Estrai pattern: prime 2-3 parole significative (no numeri/date)
          REGEXP_REPLACE(
            UPPER(TRIM(SUBSTRING(original_description FROM 1 FOR 40))),
            '[0-9\\.\\,\\/\\-]+', '', 'g'
          ) as description_pattern,
          corrected_category_id,
          corrected_subject_id,
          corrected_detail_id,
          amount,
          original_description,
          transaction_date,
          created_at
        FROM classification_feedback
        WHERE db = $1
          -- Includi TUTTI i feedback validi (sia manuali che accettati)
          AND corrected_category_id IS NOT NULL
          AND corrected_subject_id IS NOT NULL
          AND LENGTH(original_description) > 5  -- Ignora descrizioni troppo corte
      ),
      pattern_aggregates AS (
        SELECT 
          description_pattern,
          COUNT(*) as occurrences,
          COUNT(DISTINCT corrected_category_id) as unique_categories,
          COUNT(DISTINCT corrected_subject_id) as unique_subjects,
          MODE() WITHIN GROUP (ORDER BY corrected_category_id) as most_common_category,
          MODE() WITHIN GROUP (ORDER BY corrected_subject_id) as most_common_subject,
          MODE() WITHIN GROUP (ORDER BY corrected_detail_id) as most_common_detail,
          AVG(ABS(amount)) as avg_amount,
          MIN(ABS(amount)) as min_amount,
          MAX(ABS(amount)) as max_amount,
          MIN(transaction_date) as first_seen,
          MAX(transaction_date) as last_seen,
          ARRAY_AGG(original_description ORDER BY created_at DESC) 
            FILTER (WHERE original_description IS NOT NULL) 
            as example_descriptions
        FROM feedback_patterns
        WHERE LENGTH(TRIM(description_pattern)) > 3
        GROUP BY description_pattern
        HAVING COUNT(*) >= $2
      ),
      pattern_stats AS (
        SELECT 
          pa.*,
          -- Calcola consistenza: conta quanti feedback matchano la categoria/soggetto più comune
          (
            SELECT COUNT(*)::numeric
            FROM feedback_patterns fp
            WHERE fp.description_pattern = pa.description_pattern
              AND fp.corrected_category_id = pa.most_common_category
              AND fp.corrected_subject_id = pa.most_common_subject
          ) / pa.occurrences as consistency_score
        FROM pattern_aggregates pa
      )
      SELECT 
        ps.*,
        c.name as suggested_category_name,
        s.name as suggested_subject_name,
        d.name as suggested_detail_name
      FROM pattern_stats ps
      JOIN categories c ON ps.most_common_category = c.id
      JOIN subjects s ON ps.most_common_subject = s.id
      LEFT JOIN details d ON ps.most_common_detail = d.id
      WHERE ps.consistency_score >= $3
      ORDER BY ps.occurrences DESC, ps.consistency_score DESC
      LIMIT 50
    `;

    const patternsResult = await pg.query(patternsQuery, [db, minOccurrences, minConsistency]);

    // 2. Carica regole esistenti per identificare duplicati
    const rulesQuery = `
      SELECT 
        rule_name,
        description_patterns,
        category_id,
        subject_id
      FROM classification_rules
      WHERE db = $1 AND enabled = true
    `;
    const rulesResult = await pg.query(rulesQuery, [db]);
    const existingRules = rulesResult.rows;

    // 3. Filtra pattern che NON sono già coperti da regole
    const suggestions = patternsResult.rows
      .filter(pattern => {
        // Controlla se il pattern è già coperto da una regola esistente
        const isCovered = existingRules.some(rule => {
          // Confronta pattern descrizione
          const rulePatterns = Array.isArray(rule.description_patterns) 
            ? rule.description_patterns 
            : [];
          
          const patternMatches = rulePatterns.some(rulePattern => {
            const rulePatternUpper = rulePattern.toUpperCase();
            const suggestionPatternUpper = pattern.description_pattern.toUpperCase();
            return suggestionPatternUpper.includes(rulePatternUpper) ||
                   rulePatternUpper.includes(suggestionPatternUpper);
          });

          // Se pattern matcha E categoria/soggetto sono gli stessi, è duplicato
          if (patternMatches) {
            return rule.category_id === pattern.most_common_category &&
                   rule.subject_id === pattern.most_common_subject;
          }
          return false;
        });

        return !isCovered;  // Includi solo se NON è coperto
      })
      .map(pattern => {
        // Estrai prime 3 descrizioni come esempi
        const examples = pattern.example_descriptions.slice(0, 3);
        
        return {
          pattern: pattern.description_pattern.trim(),
          suggested_rule_name: `Auto: ${pattern.description_pattern.slice(0, 30).trim()}...`,
          suggested_category_id: pattern.most_common_category,
          suggested_category_name: pattern.suggested_category_name,
          suggested_subject_id: pattern.most_common_subject,
          suggested_subject_name: pattern.suggested_subject_name,
          suggested_detail_id: pattern.most_common_detail,
          suggested_detail_name: pattern.suggested_detail_name,
          statistics: {
            occurrences: pattern.occurrences,
            consistency_score: parseFloat(pattern.consistency_score),
            unique_categories: pattern.unique_categories,
            unique_subjects: pattern.unique_subjects,
            avg_amount: parseFloat(pattern.avg_amount || 0),
            amount_range: {
              min: parseFloat(pattern.min_amount || 0),
              max: parseFloat(pattern.max_amount || 0),
            },
            date_range: {
              first_seen: pattern.first_seen,
              last_seen: pattern.last_seen,
            },
          },
          examples,
          confidence: Math.round(parseFloat(pattern.consistency_score) * 100),
        };
      });

    // 4. Calcola statistiche globali
    const statsQuery = `
      SELECT 
        COUNT(*) as total_feedback,
        COUNT(*) FILTER (
          WHERE corrected_category_id = suggested_category_id
            AND corrected_subject_id = suggested_subject_id
            AND (corrected_detail_id = suggested_detail_id OR (corrected_detail_id IS NULL AND suggested_detail_id IS NULL))
        ) as accepted_without_changes,
        COUNT(DISTINCT corrected_category_id) as unique_categories_used,
        COUNT(DISTINCT corrected_subject_id) as unique_subjects_used,
        MIN(created_at) as oldest_feedback,
        MAX(created_at) as newest_feedback
      FROM classification_feedback
      WHERE db = $1
    `;
    const statsResult = await pg.query(statsQuery, [db]);

    return {
      success: true,
      suggestions,
      stats: {
        total_suggestions: suggestions.length,
        total_feedback_analyzed: statsResult.rows[0].total_feedback,
        accepted_feedback: statsResult.rows[0].accepted_without_changes,
        unique_categories: statsResult.rows[0].unique_categories_used,
        unique_subjects: statsResult.rows[0].unique_subjects_used,
        date_range: {
          oldest: statsResult.rows[0].oldest_feedback,
          newest: statsResult.rows[0].newest_feedback,
        },
        filters: {
          min_occurrences: minOccurrences,
          min_consistency: minConsistency,
        },
      },
      latency_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error('[Suggested Rules] Error analyzing patterns:', error);
    return {
      success: false,
      error: error.message,
      suggestions: [],
      stats: {},
      latency_ms: Date.now() - startTime,
    };
  }
}

/**
 * Calcola analytics e metriche del sistema di classificazione
 * 
 * OTTIMIZZAZIONE: Esegue 7 query in parallelo con Promise.all()
 * invece che sequenzialmente (~2-3x più veloce)
 */
export async function calculateAnalytics(db, pg, days = 30) {
  const startTime = Date.now();

  try {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    // Esegui TUTTE le query in parallelo con Promise.all()
    const [
      methodDistResult,
      confidenceTrendResult,
      topCategoriesResult,
      topSubjectsResult,
      overallStatsResult,
      confidenceRangesResult,
      rulesStatsResult,
    ] = await Promise.all([
      // 1. Method distribution
      pg.query(`
        SELECT 
          suggestion_method as method,
          COUNT(*) as count,
          ROUND(AVG(suggestion_confidence), 2) as avg_confidence,
          COUNT(*) FILTER (
            WHERE corrected_category_id = suggested_category_id
              AND corrected_subject_id = suggested_subject_id
          )::numeric / NULLIF(COUNT(*), 0) as accuracy
        FROM classification_feedback
        WHERE db = $1 AND created_at >= $2 AND suggestion_method IS NOT NULL
        GROUP BY suggestion_method ORDER BY count DESC
      `, [db, dateFrom]),

      // 2. Confidence trend
      pg.query(`
        SELECT 
          DATE_TRUNC('week', created_at) as week,
          ROUND(AVG(suggestion_confidence), 2) as avg_confidence,
          COUNT(*) as classifications_count,
          COUNT(*) FILTER (
            WHERE corrected_category_id = suggested_category_id
              AND corrected_subject_id = suggested_subject_id
          )::numeric / NULLIF(COUNT(*), 0) as accuracy
        FROM classification_feedback
        WHERE db = $1 AND created_at >= $2
        GROUP BY week ORDER BY week ASC
      `, [db, dateFrom]),

      // 3. Top categories
      pg.query(`
        SELECT 
          c.name as category_name, COUNT(*) as count,
          ROUND(AVG(cf.suggestion_confidence), 2) as avg_confidence
        FROM classification_feedback cf
        JOIN categories c ON cf.corrected_category_id = c.id
        WHERE cf.db = $1 AND cf.created_at >= $2
        GROUP BY c.id, c.name ORDER BY count DESC LIMIT 10
      `, [db, dateFrom]),

      // 4. Top subjects
      pg.query(`
        SELECT 
          s.name as subject_name, c.name as category_name, COUNT(*) as count,
          ROUND(AVG(cf.suggestion_confidence), 2) as avg_confidence
        FROM classification_feedback cf
        JOIN subjects s ON cf.corrected_subject_id = s.id
        JOIN categories c ON s.category_id = c.id
        WHERE cf.db = $1 AND cf.created_at >= $2
        GROUP BY s.id, s.name, c.name ORDER BY count DESC LIMIT 10
      `, [db, dateFrom]),

      // 5. Overall stats
      pg.query(`
        SELECT 
          COUNT(*) as total_classifications,
          COUNT(DISTINCT transaction_id) as unique_transactions,
          ROUND(AVG(suggestion_confidence), 2) as avg_confidence,
          MIN(suggestion_confidence) as min_confidence,
          MAX(suggestion_confidence) as max_confidence,
          COUNT(*) FILTER (
            WHERE corrected_category_id = suggested_category_id
              AND corrected_subject_id = suggested_subject_id
              AND (corrected_detail_id = suggested_detail_id OR (corrected_detail_id IS NULL AND suggested_detail_id IS NULL))
          )::numeric / NULLIF(COUNT(*), 0) as overall_accuracy,
          ROUND(COUNT(*)::numeric / NULLIF($2, 0), 2) as avg_per_day
        FROM classification_feedback
        WHERE db = $1 AND created_at >= $3
      `, [db, days, dateFrom]),

      // 6. Confidence ranges
      pg.query(`
        WITH ranges AS (
          SELECT 
            CASE 
              WHEN suggestion_confidence >= 95 THEN '95-100%'
              WHEN suggestion_confidence >= 90 THEN '90-95%'
              WHEN suggestion_confidence >= 80 THEN '80-90%'
              WHEN suggestion_confidence >= 70 THEN '70-80%'
              ELSE '<70%'
            END as confidence_range,
            corrected_category_id, suggested_category_id,
            corrected_subject_id, suggested_subject_id
          FROM classification_feedback
          WHERE db = $1 AND created_at >= $2
        )
        SELECT 
          confidence_range,
          COUNT(*) as count,
          COUNT(*) FILTER (
            WHERE corrected_category_id = suggested_category_id
              AND corrected_subject_id = suggested_subject_id
          )::numeric / NULLIF(COUNT(*), 0) as accuracy
        FROM ranges
        GROUP BY confidence_range
        ORDER BY 
          CASE confidence_range
            WHEN '95-100%' THEN 1 
            WHEN '90-95%' THEN 2 
            WHEN '80-90%' THEN 3
            WHEN '70-80%' THEN 4 
            ELSE 5 
          END
      `, [db, dateFrom]),

      // 7. Rules
      pg.query(`
        SELECT 
          COUNT(*) as total_rules,
          COUNT(*) FILTER (WHERE enabled = true) as active_rules,
          COUNT(*) FILTER (WHERE enabled = false) as disabled_rules
        FROM classification_rules WHERE db = $1
      `, [db]),
    ]);

    return {
      success: true,
      analytics: {
        period: { days, from: dateFrom, to: new Date() },
        overall: overallStatsResult.rows[0] || {},
        method_distribution: methodDistResult.rows.map(row => ({
          method: row.method, count: parseInt(row.count),
          avg_confidence: parseFloat(row.avg_confidence || 0),
          accuracy: parseFloat(row.accuracy || 0),
        })),
        confidence_trend: confidenceTrendResult.rows.map(row => ({
          week: row.week, avg_confidence: parseFloat(row.avg_confidence || 0),
          count: parseInt(row.classifications_count), accuracy: parseFloat(row.accuracy || 0),
        })),
        confidence_ranges: confidenceRangesResult.rows.map(row => ({
          range: row.confidence_range, count: parseInt(row.count),
          accuracy: parseFloat(row.accuracy || 0),
        })),
        top_categories: topCategoriesResult.rows.map(row => ({
          name: row.category_name, count: parseInt(row.count),
          avg_confidence: parseFloat(row.avg_confidence || 0),
        })),
        top_subjects: topSubjectsResult.rows.map(row => ({
          name: row.subject_name, category: row.category_name,
          count: parseInt(row.count), avg_confidence: parseFloat(row.avg_confidence || 0),
        })),
        rules: rulesStatsResult.rows[0] || {},
      },
      latency_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error('[Analytics] Error:', error);
    return { success: false, error: error.message, analytics: {}, latency_ms: Date.now() - startTime };
  }
}
