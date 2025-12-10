/**
 * Smart Pattern Classifier
 * Analizza pattern testuali, importi e altre euristiche per classificazioni intelligenti
 */

const smartRules = [
  // COMMISSIONI BANCARIE - Solo vere commissioni (importi piccoli)
  {
    name: 'Commissioni Bancarie - Pattern esplicito',
    priority: 100,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const amount = Math.abs(transaction.amount);
      
      // Pattern flessibili per "commissioni" (comm., commis., commissioni, ecc.)
      const commissionPatterns = ['COMMISSIONI', 'COMMISS', 'COMM.', 'COMM ', 'COMM:'];
      const hasCommissioni = commissionPatterns.some(pattern => desc.includes(pattern));
      const isSmallAmount = amount >= 0.3 && amount <= 5;
      
      return hasCommissioni && isSmallAmount;
    },
    category: 'Banche',
    subject: 'Spese bancarie',
    confidence: 98,
    reasoning: 'Commissione bancaria identificata da importo tipico (< 5€)'
  },
  
  // SPESE BANCARIE GENERICHE (piccoli importi con keywords)
  {
    name: 'Spese Bancarie - Importo e keywords',
    priority: 90,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const amount = Math.abs(transaction.amount);
      
      const bankKeywords = ['IMPOSTA', 'BOLLO', 'CANONE', 'TENUTA CONTO', 'SPESE'];
      const hasBankKeyword = bankKeywords.some(kw => desc.includes(kw));
      const isSmallAmount = amount >= 0.5 && amount <= 50;
      
      return hasBankKeyword && isSmallAmount;
    },
    category: 'Banche',
    subject: 'Spese bancarie',
    confidence: 85,
    reasoning: 'Spesa bancaria identificata da keywords e importo tipico'
  },
  
  // BONIFICI
  {
    name: 'Bonifico',
    priority: 85,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      return desc.includes('BONIFICO') && !desc.includes('COMMISSIONI');
    },
    category: 'Banche',
    subject: 'Bonifici',
    confidence: 90,
    reasoning: 'Bonifico identificato dalla descrizione'
  },
  
  // PRELIEVI ATM
  {
    name: 'Prelievo ATM',
    priority: 85,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      return desc.includes('PRELIEVO') || desc.includes('ATM') || desc.includes('BANCOMAT');
    },
    category: 'Banche',
    subject: 'Prelievi',
    confidence: 95,
    reasoning: 'Prelievo ATM identificato dalla descrizione'
  },
  
  // UTENZE - Pattern tipici
  {
    name: 'Utenze - Provider noti',
    priority: 80,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const utilities = ['ENEL', 'ENI', 'A2A', 'HERA', 'ACEA', 'MULTISERVIZI', 
                        'ACQUEDOTTO', 'GAS', 'LUCE', 'ENERGIA'];
      return utilities.some(provider => desc.includes(provider));
    },
    category: 'Casa',
    subject: 'Utenze',
    confidence: 92,
    reasoning: 'Provider di utenze riconosciuto'
  },
  
  // ABBONAMENTI TELEFONICI
  {
    name: 'Telefonia',
    priority: 80,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const telco = ['TIM', 'VODAFONE', 'WIND', 'TRE', 'ILIAD', 'FASTWEB', 'TELECOM'];
      const hasTelco = telco.some(provider => desc.includes(provider));
      const isNotCommission = !desc.includes('COMMISSIONI') && !desc.includes('CCBS');
      const isRecurring = Math.abs(transaction.amount) > 5; // Abbonamenti > 5€
      
      return hasTelco && isNotCommission && isRecurring;
    },
    category: 'Casa',
    subject: 'Telefonia',
    confidence: 88,
    reasoning: 'Abbonamento telefonico identificato'
  },
  
  // ASSICURAZIONI
  {
    name: 'Assicurazioni',
    priority: 85,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const insurance = ['ASSICURAZIONE', 'POLIZZA', 'RCA', 'KASKO', 'GENERALI', 
                        'ALLIANZ', 'AXA', 'UNIPOL', 'REALE MUTUA'];
      return insurance.some(kw => desc.includes(kw));
    },
    category: 'Auto',
    subject: 'Assicurazione',
    confidence: 95,
    reasoning: 'Assicurazione identificata da keywords'
  },
  
  // CARBURANTE
  {
    name: 'Carburante',
    priority: 80,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const fuel = ['CARBURANTE', 'BENZINA', 'DIESEL', 'GPL', 'METANO', 'RIFORNIMENTO',
                   'TAMOIL', 'Q8', 'IP', 'AGIP', 'ESSO', 'SHELL'];
      return fuel.some(kw => desc.includes(kw));
    },
    category: 'Auto',
    subject: 'Carburante',
    confidence: 92,
    reasoning: 'Carburante identificato da keywords'
  },
  
  // SUPERMERCATI
  {
    name: 'Supermercati',
    priority: 75,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const supermarkets = ['CONAD', 'COOP', 'ESSELUNGA', 'CARREFOUR', 'LIDL', 'EUROSPIN',
                           'PENNY', 'MD', 'ALDI', 'BENNET', 'IPER', 'PAM', 'DESPAR'];
      return supermarkets.some(sm => desc.includes(sm));
    },
    category: 'Famiglia',
    subject: 'Spesa',
    confidence: 90,
    reasoning: 'Supermercato riconosciuto'
  },
  
  // RISTORANTI/BAR
  {
    name: 'Ristorazione',
    priority: 70,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      const dining = ['RISTORANTE', 'PIZZERIA', 'TRATTORIA', 'BAR', 'CAFE', 'OSTERIA'];
      return dining.some(kw => desc.includes(kw));
    },
    category: 'Famiglia',
    subject: 'Ristoranti',
    confidence: 85,
    reasoning: 'Locale identificato da keywords'
  },
  
  // FARMACIA
  {
    name: 'Farmacia',
    priority: 85,
    test: (transaction) => {
      const desc = transaction.description.toUpperCase();
      return desc.includes('FARMACIA') || desc.includes('PARAFARMACIA');
    },
    category: 'Famiglia',
    subject: 'Salute',
    confidence: 95,
    reasoning: 'Farmacia identificata'
  }
];

/**
 * Analizza una transazione e ritorna una classificazione se matcha delle regole
 */
function analyzeTransaction(transaction, db) {
  // Ordina per priorità
  const sortedRules = [...smartRules].sort((a, b) => b.priority - a.priority);
  
  for (const rule of sortedRules) {
    try {
      if (rule.test(transaction)) {
        console.log(`✅ Smart rule matched: ${rule.name}`);
        return {
          category_name: rule.category,
          subject_name: rule.subject,
          detail_name: rule.detail || null,
          confidence: rule.confidence,
          reasoning: rule.reasoning,
          method: 'smart_rules',
          rule_name: rule.name
        };
      }
    } catch (error) {
      console.error(`Error testing rule ${rule.name}:`, error);
    }
  }
  
  return null; // Nessuna regola matchata
}

/**
 * Route handler per analisi smart
 */
export default async function smartClassifyRoute(fastify, options) {
  // POST /v1/transaction/smart-classify
  fastify.post('/smart-classify', async (request, reply) => {
    try {
      const { transaction, db } = request.body;
      
      if (!transaction || !db) {
        return reply.code(400).send({
          success: false,
          error: 'Missing required fields: transaction, db'
        });
      }
      
      const result = analyzeTransaction(transaction, db);
      
      if (result) {
        // Cerca gli ID reali delle categorie/soggetti dal database
        const categoryQuery = await fastify.pg.query(
          'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND db = $2',
          [result.category_name, db]
        );
        
        const subjectQuery = await fastify.pg.query(
          'SELECT id FROM subjects WHERE LOWER(name) = LOWER($1) AND category_id = $2',
          [result.subject_name, categoryQuery.rows[0]?.id]
        );
        
        if (categoryQuery.rows.length > 0 && subjectQuery.rows.length > 0) {
          return reply.send({
            success: true,
            classification: {
              ...result,
              category_id: categoryQuery.rows[0].id,
              subject_id: subjectQuery.rows[0].id,
              detail_id: null
            }
          });
        }
      }
      
      // Nessuna regola matchata
      return reply.send({
        success: true,
        classification: null,
        reason: 'No smart rule matched'
      });
      
    } catch (error) {
      console.error('Smart classify error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message
      });
    }
  });
}
